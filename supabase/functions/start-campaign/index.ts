// CareCall — Start (or continue) a campaign.
// Called by the staff portal: POST { campaign_id, batch_size? }
// Dials pending patients sequentially-ish with AMD enabled and creates a
// call_log row per call so tool webhooks can resolve context by call_control_id.
//
// MVP note: this dials one small batch per invocation. For production pacing,
// schedule this function with pg_cron / Supabase scheduled functions and add
// concurrency + calling-hours guards.

import { supabase, telnyx, json } from "../_shared/lib.ts";

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
    const patient = row.patients as {
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
