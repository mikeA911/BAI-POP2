// CareCall — user & clinic administration.
//
// Actions (POST { action, ...args }):
//   create_user       — role + clinic_id. Clinic Admin may only create Staff in
//                        their own clinic; Admin may create any role/clinic.
//   set_role          — Admin only.
//   reset_password    — set a temporary password + force-change flag.
//   deactivate_user   — ban (banned_until far future), blocks token refresh.
//   reactivate_user   — lift the ban.
//   create_clinic     — Admin only.
//
// Role + clinic_id live in auth.users.app_metadata and are ONLY ever written
// here (never client-writable). Every action writes an audit_log row.
//
// Deploy with JWT verification ON (default): callers must be authenticated
// portal users. Authorization is enforced per-action below.

import { supabase, json, getCaller, audit, corsHeaders } from "../_shared/lib.ts";

const FORCE_CHANGE_KEY = "force_password_change";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  const caller = await getCaller(req);
  if (!caller || !caller.role) return json({ error: "unauthorized" }, 401, corsHeaders());

  const body = await req.json().catch(() => ({}));
  const action: string = body.action;

  try {
    switch (action) {
      case "list_users":      return await listUsers(caller);
      case "create_user":     return await createUser(caller, body);
      case "set_role":        return await setRole(caller, body);
      case "reset_password":  return await resetPassword(caller, body);
      case "deactivate_user": return await setBanned(caller, body, true);
      case "reactivate_user": return await setBanned(caller, body, false);
      case "create_clinic":   return await createClinic(caller, body);
      default:                return json({ error: `unknown action: ${action}` }, 400, corsHeaders());
    }
  } catch (e) {
    console.error(`admin-manage ${action} error`, e);
    return json({ error: (e as Error).message ?? "internal error" }, 500, corsHeaders());
  }
});

type Caller = NonNullable<Awaited<ReturnType<typeof getCaller>>>;

function tempPassword(): string {
  // Human-typeable temporary password: 3 groups, no ambiguous chars.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const pick = (n: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map((b) => alphabet[b % alphabet.length]).join("");
  return `${pick(4)}-${pick(4)}-${pick(4)}`;
}

async function requireTargetInScope(caller: Caller, userId: string) {
  const { data } = await supabase.auth.admin.getUserById(userId);
  const target = data?.user;
  if (!target) throw new Error("user not found");
  const targetClinic = (target.app_metadata as Record<string, unknown>)?.clinic_id as string | undefined;
  if (!caller.role.startsWith("admin") && !isAdmin(caller)) {
    // clinic_admin: must be same clinic
    if (targetClinic !== caller.clinicId) throw new Error("forbidden: user in another clinic");
  }
  return target;
}

function isAdmin(caller: Caller) { return caller.role === "admin"; }
function isClinicAdmin(caller: Caller) { return caller.role === "admin" || caller.role === "clinic_admin"; }

// ------------------------------------------------------------------
// list_users — Clinic Admin sees own-clinic users; Admin sees all.
async function listUsers(caller: Caller) {
  if (!isClinicAdmin(caller)) return json({ error: "forbidden" }, 403, corsHeaders());
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) return json({ error: error.message }, 400, corsHeaders());
  const users = data.users
    .map((u) => {
      const meta = (u.app_metadata ?? {}) as Record<string, unknown>;
      return {
        id: u.id,
        email: u.email,
        role: (meta.role as string) ?? "",
        clinic_id: (meta.clinic_id as string) ?? null,
        deactivated: !!(u as unknown as { banned_until?: string }).banned_until,
        last_sign_in_at: u.last_sign_in_at ?? null,
        created_at: u.created_at,
      };
    })
    .filter((u) => isAdmin(caller) || u.clinic_id === caller.clinicId);
  return json({ users }, 200, corsHeaders());
}

// ------------------------------------------------------------------
async function createUser(caller: Caller, body: Record<string, unknown>) {
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "staff") as "admin" | "clinic_admin" | "staff";
  let clinicId = (body.clinic_id as string) ?? caller.clinicId;

  if (!email) return json({ error: "email required" }, 400, corsHeaders());
  if (!["admin", "clinic_admin", "staff"].includes(role))
    return json({ error: "invalid role" }, 400, corsHeaders());

  // Permission matrix:
  //  - Only Admin may create Admin or Clinic Admin, or create in another clinic.
  //  - Clinic Admin may create Staff only, in their own clinic.
  if (!isClinicAdmin(caller)) return json({ error: "forbidden" }, 403, corsHeaders());
  if (!isAdmin(caller)) {
    if (role !== "staff") return json({ error: "clinic admins may only create Staff" }, 403, corsHeaders());
    clinicId = caller.clinicId; // force own clinic
  }
  if (role !== "admin" && !clinicId)
    return json({ error: "clinic_id required for non-admin users" }, 400, corsHeaders());

  const password = tempPassword();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // pre-confirmed; no SMTP dependency (D4)
    app_metadata: { role, clinic_id: role === "admin" ? null : clinicId, [FORCE_CHANGE_KEY]: true },
  });
  if (error) return json({ error: error.message }, 400, corsHeaders());

  await audit({
    clinicId: clinicId ?? null, actorUserId: caller.userId,
    action: "user_created", targetType: "user", targetId: data.user?.id,
    detail: { email, role, clinic_id: clinicId },
  });

  return json({ ok: true, user_id: data.user?.id, temporary_password: password }, 200, corsHeaders());
}

// ------------------------------------------------------------------
async function setRole(caller: Caller, body: Record<string, unknown>) {
  if (!isAdmin(caller)) return json({ error: "forbidden: admin only" }, 403, corsHeaders());
  const userId = String(body.user_id ?? "");
  const role = String(body.role ?? "") as "admin" | "clinic_admin" | "staff";
  const clinicId = (body.clinic_id as string) ?? null;
  if (!userId || !["admin", "clinic_admin", "staff"].includes(role))
    return json({ error: "user_id and valid role required" }, 400, corsHeaders());

  const { data: existing } = await supabase.auth.admin.getUserById(userId);
  const prevMeta = (existing?.user?.app_metadata ?? {}) as Record<string, unknown>;

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { ...prevMeta, role, clinic_id: role === "admin" ? null : clinicId },
  });
  if (error) return json({ error: error.message }, 400, corsHeaders());

  await audit({
    clinicId, actorUserId: caller.userId, action: "user_role_changed",
    targetType: "user", targetId: userId, detail: { role, clinic_id: clinicId },
  });
  // Caller-facing note: JWT only refreshes on next login.
  return json({ ok: true, note: "User must sign out and back in for the new role to apply." }, 200, corsHeaders());
}

// ------------------------------------------------------------------
async function resetPassword(caller: Caller, body: Record<string, unknown>) {
  if (!isClinicAdmin(caller)) return json({ error: "forbidden" }, 403, corsHeaders());
  const userId = String(body.user_id ?? "");
  if (!userId) return json({ error: "user_id required" }, 400, corsHeaders());
  const target = await requireTargetInScope(caller, userId);

  const password = tempPassword();
  const prevMeta = (target.app_metadata ?? {}) as Record<string, unknown>;
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    password,
    app_metadata: { ...prevMeta, [FORCE_CHANGE_KEY]: true },
  });
  if (error) return json({ error: error.message }, 400, corsHeaders());

  await audit({
    clinicId: (prevMeta.clinic_id as string) ?? caller.clinicId,
    actorUserId: caller.userId, action: "password_reset",
    targetType: "user", targetId: userId,
  });
  return json({ ok: true, temporary_password: password }, 200, corsHeaders());
}

// ------------------------------------------------------------------
async function setBanned(caller: Caller, body: Record<string, unknown>, banned: boolean) {
  if (!isClinicAdmin(caller)) return json({ error: "forbidden" }, 403, corsHeaders());
  const userId = String(body.user_id ?? "");
  if (!userId) return json({ error: "user_id required" }, 400, corsHeaders());
  const target = await requireTargetInScope(caller, userId);

  // Supabase ban via banned_until (100y = deactivated; "none" reactivates).
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: banned ? "876000h" : "none",
  } as unknown as { ban_duration: string });
  if (error) return json({ error: error.message }, 400, corsHeaders());

  await audit({
    clinicId: ((target.app_metadata as Record<string, unknown>)?.clinic_id as string) ?? caller.clinicId,
    actorUserId: caller.userId, action: banned ? "user_deactivated" : "user_reactivated",
    targetType: "user", targetId: userId,
  });
  return json({ ok: true }, 200, corsHeaders());
}

// ------------------------------------------------------------------
async function createClinic(caller: Caller, body: Record<string, unknown>) {
  if (!isAdmin(caller)) return json({ error: "forbidden: admin only" }, 403, corsHeaders());
  const name = String(body.name ?? "").trim();
  if (!name) return json({ error: "name required" }, 400, corsHeaders());

  const { data, error } = await supabase.from("clinics").insert({
    name,
    timezone: (body.timezone as string) ?? "America/Chicago",
    phone_callback: (body.phone_callback as string) ?? null,
    greeting_default: (body.greeting_default as string) ?? null,
  }).select("id").single();
  if (error) return json({ error: error.message }, 400, corsHeaders());

  await audit({
    clinicId: data.id, actorUserId: caller.userId, action: "clinic_created",
    targetType: "clinic", targetId: data.id, detail: { name },
  });
  return json({ ok: true, clinic_id: data.id }, 200, corsHeaders());
}
