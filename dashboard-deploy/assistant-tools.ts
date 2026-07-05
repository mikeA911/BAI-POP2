// assistant-tools — DASHBOARD-DEPLOY VERSION (shared helpers inlined, no _shared import)
// Paste this entire file into the Supabase dashboard editor.

// Shared helpers for CareCall edge functions (Deno / Supabase Edge Runtime)
import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // service role: bypasses RLS, server-side only
);

const TELNYX_API = "https://api.telnyx.com/v2";

async function telnyx(path: string, body: unknown, method = "POST") {
  const res = await fetch(`${TELNYX_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${Deno.env.get("TELNYX_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Telnyx ${path} failed`, res.status, JSON.stringify(json));
    throw new Error(`Telnyx API error ${res.status}`);
  }
  return json;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Verify requests from Telnyx tool webhooks using a shared secret header. */
function checkToolSecret(req: Request): boolean {
  return req.headers.get("x-carecall-secret") === Deno.env.get("TOOL_WEBHOOK_SECRET");
}

/** Format a timestamptz into speech-friendly text, e.g. "Tuesday, July 7th at 10:00 AM". */
function speakable(iso: string, tz: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  return `${day} at ${time}`;
}


// ============ function code ============
// CareCall — Telnyx AI Assistant tool webhooks.
// One endpoint, dispatched by ?tool=<name>. Register each tool in the Telnyx
// assistant as a webhook tool pointing here (see telnyx/tools.json).
//
// Security model:
//  - The AI is NEVER given the patient's DOB on file. It collects a stated DOB
//    and verify_patient compares it server-side, returning only match/no-match.
//  - All tools require the x-carecall-secret header (set as a Telnyx integration secret).
//  - create_appointment is idempotent via idempotency_key.


const CLINIC_TZ = Deno.env.get("CLINIC_TZ") ?? "America/Chicago";
const MAX_VERIFY_ATTEMPTS = 2; // initial attempt + one retry

Deno.serve(async (req) => {
  if (!checkToolSecret(req)) return json({ error: "unauthorized" }, 401);

  const tool = new URL(req.url).searchParams.get("tool");
  const body = await req.json().catch(() => ({}));
  // Telnyx sends dynamic variables incl. call_control_id with tool calls
  const args = body?.data?.payload?.arguments ?? body?.arguments ?? body;
  const callControlId: string | undefined =
    body?.data?.payload?.call_control_id ?? args?.call_control_id;

  try {
    switch (tool) {
      case "verify_patient":       return await verifyPatient(callControlId, args);
      case "get_appointment_slots": return await getSlots(callControlId, args);
      case "create_appointment":   return await createAppointment(callControlId, args);
      case "mark_outcome":         return await markOutcome(callControlId, args);
      default:                     return json({ error: `unknown tool: ${tool}` }, 400);
    }
  } catch (e) {
    console.error(`tool ${tool} error`, e);
    return json({ error: "internal error", say: "I'm sorry, I'm having a technical issue." }, 500);
  }
});

/** Look up call context (patient + campaign) from the call log created at dial time. */
async function callContext(callControlId?: string) {
  if (!callControlId) throw new Error("missing call_control_id");
  const { data, error } = await supabase
    .from("call_logs")
    .select("id, patient_id, campaign_id, verification_attempts, verified, patients(*), campaigns(*)")
    .eq("call_control_id", callControlId)
    .single();
  if (error || !data) throw new Error("call context not found");
  return data;
}

// ------------------------------------------------------------------
// verify_patient — AI passes stated_date_of_birth (YYYY-MM-DD).
// Server compares. Returns match:boolean and remaining_attempts.
// After MAX_VERIFY_ATTEMPTS failures → locked:true, AI must end call.
// ------------------------------------------------------------------
async function verifyPatient(callControlId: string | undefined, args: Record<string, string>) {
  const ctx = await callContext(callControlId);
  const patient = ctx.patients as { date_of_birth: string; first_name: string };

  if (ctx.verification_attempts >= MAX_VERIFY_ATTEMPTS) {
    return json({ match: false, locked: true });
  }

  const stated = (args.stated_date_of_birth ?? "").trim();
  const match = stated === patient.date_of_birth;
  const attempts = ctx.verification_attempts + 1;

  await supabase.from("call_logs")
    .update({ verification_attempts: attempts, verified: match })
    .eq("id", ctx.id);

  if (!match && attempts >= MAX_VERIFY_ATTEMPTS) {
    // Flag for human follow-up
    await supabase.from("campaign_patients")
      .update({ status: "verification_failed", flag_reason: "DOB mismatch after retry", updated_at: new Date().toISOString() })
      .eq("campaign_id", ctx.campaign_id).eq("patient_id", ctx.patient_id);
    return json({ match: false, locked: true });
  }

  return json({ match, locked: false, remaining_attempts: MAX_VERIFY_ATTEMPTS - attempts });
}

// ------------------------------------------------------------------
// get_appointment_slots — progressive disclosure.
// granularity: "weeks" → distinct upcoming days grouped by week
//              "days"  → available days within a given week
//              "times" → up to 3 concrete times on a given day
// Returns speech-ready strings so the AI never invents times.
// ------------------------------------------------------------------
async function getSlots(callControlId: string | undefined, args: Record<string, string>) {
  const ctx = await callContext(callControlId);
  if (!ctx.verified) return json({ error: "patient not verified", say: "Please verify the patient first." }, 403);

  const campaign = ctx.campaigns as { provider_id: string | null };
  const patient = ctx.patients as { provider_id: string | null };
  const providerId = campaign.provider_id ?? patient.provider_id;
  if (!providerId) return json({ slots: [], say: "No provider is configured for this patient." });

  const { data: slots, error } = await supabase.rpc("get_available_slots", {
    p_provider_id: providerId,
    p_from: args.from_date ?? undefined,
    p_days: args.days ? Number(args.days) : 14,
    p_limit: 60,
    p_tz: CLINIC_TZ, // slots are generated in clinic-local wall-clock time
  });
  if (error) throw error;

  const granularity = args.granularity ?? "times";

  if (granularity === "days") {
    const seen = new Set<string>();
    const days: { date: string; spoken: string }[] = [];
    for (const s of slots) {
      const date = new Date(s.slot_start).toLocaleDateString("en-CA", { timeZone: CLINIC_TZ });
      if (!seen.has(date)) {
        seen.add(date);
        days.push({
          date,
          spoken: new Date(s.slot_start).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: CLINIC_TZ }),
        });
      }
      if (days.length >= 3) break;
    }
    return json({ days });
  }

  // granularity === "times": up to 3 times, optionally filtered to one day
  let filtered = slots as { slot_start: string; slot_end: string }[];
  if (args.on_date) {
    filtered = filtered.filter(
      (s) => new Date(s.slot_start).toLocaleDateString("en-CA", { timeZone: CLINIC_TZ }) === args.on_date,
    );
  }
  const times = filtered.slice(0, 3).map((s) => ({
    slot_start: s.slot_start,
    slot_end: s.slot_end,
    spoken: speakable(s.slot_start, CLINIC_TZ),
  }));
  return json({ times });
}

// ------------------------------------------------------------------
// create_appointment — only after explicit patient confirmation.
// Idempotent: key = call_control_id + slot_start.
// ------------------------------------------------------------------
async function createAppointment(callControlId: string | undefined, args: Record<string, string>) {
  const ctx = await callContext(callControlId);
  if (!ctx.verified) return json({ error: "patient not verified" }, 403);
  if (!args.slot_start) return json({ error: "slot_start required" }, 400);

  const campaign = ctx.campaigns as { provider_id: string | null; slot_length_minutes: number };
  const patient = ctx.patients as { provider_id: string | null };
  const providerId = campaign.provider_id ?? patient.provider_id!;
  const startsAt = new Date(args.slot_start);
  const endsAt = new Date(startsAt.getTime() + (campaign.slot_length_minutes ?? 30) * 60_000);
  const idempotencyKey = `${callControlId}:${args.slot_start}`;

  const { data: existing } = await supabase.from("appointments")
    .select("id, starts_at").eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing) {
    return json({ booked: true, appointment_id: existing.id, spoken: speakable(existing.starts_at, CLINIC_TZ) });
  }

  const { data: appt, error } = await supabase.from("appointments").insert({
    patient_id: ctx.patient_id,
    provider_id: providerId,
    campaign_id: ctx.campaign_id,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    idempotency_key: idempotencyKey,
  }).select("id").single();

  if (error) {
    // Exclusion constraint = slot was just taken. Tell the AI to re-fetch.
    if (error.code === "23P01") {
      return json({ booked: false, reason: "slot_taken", say: "That time was just taken. Please fetch new options." });
    }
    throw error;
  }

  await Promise.all([
    supabase.from("campaign_patients")
      .update({ status: "booked", updated_at: new Date().toISOString() })
      .eq("campaign_id", ctx.campaign_id).eq("patient_id", ctx.patient_id),
    supabase.from("call_logs").update({ appointment_id: appt.id, result: "booked" }).eq("id", ctx.id),
  ]);

  return json({ booked: true, appointment_id: appt.id, spoken: speakable(startsAt.toISOString(), CLINIC_TZ) });
}

// ------------------------------------------------------------------
// mark_outcome — declined | callback_requested | wrong_number | needs_human
// ------------------------------------------------------------------
async function markOutcome(callControlId: string | undefined, args: Record<string, string>) {
  const ctx = await callContext(callControlId);
  const outcome = args.outcome;
  const allowed = ["declined", "callback_requested", "wrong_number", "needs_human"];
  if (!allowed.includes(outcome)) return json({ error: `outcome must be one of ${allowed.join(", ")}` }, 400);

  const update: Record<string, unknown> = { status: outcome, updated_at: new Date().toISOString() };
  if (outcome === "callback_requested") {
    update.callback_after = args.callback_after ?? new Date(Date.now() + 86_400_000).toISOString();
  }
  if (args.note) update.flag_reason = args.note;

  await Promise.all([
    supabase.from("campaign_patients").update(update)
      .eq("campaign_id", ctx.campaign_id).eq("patient_id", ctx.patient_id),
    supabase.from("call_logs").update({ result: outcome === "needs_human" ? "transferred" : outcome }).eq("id", ctx.id),
  ]);

  return json({ recorded: true });
}
