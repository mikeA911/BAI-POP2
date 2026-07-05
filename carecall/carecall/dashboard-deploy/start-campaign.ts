// start-campaign — DASHBOARD-DEPLOY VERSION (shared helpers inlined, no _shared import)
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
// CareCall — Start (or continue) a campaign.
// Called by the staff portal: POST { campaign_id, batch_size? }
// Dials pending patients sequentially-ish with AMD enabled and creates a
// call_log row per call so tool webhooks can resolve context by call_control_id.
//
// MVP note: this dials one small batch per invocation. For production pacing,
// schedule this function with pg_cron / Supabase scheduled functions and add
// concurrency + calling-hours guards.


const CONNECTION_ID = Deno.env.get("TELNYX_CONNECTION_ID")!; // Call Control App ID
const FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;

Deno.serve(async (req) => {
  // Require a logged-in staff member (anon key + user JWT from the portal)
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const { campaign_id, batch_size = 3 } = await req.json();
  if (!campaign_id) return json({ error: "campaign_id required" }, 400);

  const { data: campaign } = await supabase.from("campaigns")
    .select("*").eq("id", campaign_id).single();
  if (!campaign?.active) return json({ error: "campaign not found or inactive" }, 404);

  // Pending patients + callbacks that are now due
  const { data: queue } = await supabase.from("campaign_patients")
    .select("patient_id, status, attempts, callback_after, patients(*)")
    .eq("campaign_id", campaign_id)
    .or(`status.eq.pending,and(status.eq.callback_requested,callback_after.lte.${new Date().toISOString()})`)
    .limit(batch_size);

  if (!queue?.length) return json({ started: 0, message: "no pending patients" });

  let started = 0;
  for (const row of queue) {
    const patient = row.patients as unknown as {
      id: string; first_name: string; phone: string;
    };

    const clientState = btoa(JSON.stringify({
      campaign_id,
      patient_id: patient.id,
      patient_phone: patient.phone,
      patient_first_name: patient.first_name,
      campaign_context: campaign.greeting_context,
    }));

    try {
      const call = await telnyx("/calls", {
        connection_id: CONNECTION_ID,
        to: patient.phone,
        from: FROM_NUMBER,
        answering_machine_detection: "premium", // fires call.machine.detection.ended
        client_state: clientState,
        timeout_secs: 30,
      });

      const ccid = call?.data?.call_control_id;
      await Promise.all([
        supabase.from("call_logs").insert({
          call_control_id: ccid,
          patient_id: patient.id,
          campaign_id,
        }),
        supabase.from("campaign_patients").update({
          status: "calling",
          attempts: ((row as { attempts?: number }).attempts ?? 0) + 1,
          last_attempt_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("campaign_id", campaign_id).eq("patient_id", patient.id),
      ]);
      started++;
    } catch (e) {
      console.error(`dial failed for patient ${patient.id}`, e);
    }
  }

  return json({ started });
});
