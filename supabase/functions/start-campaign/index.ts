// CareCall — Start (or continue) a campaign.
// Called by the staff portal: POST { campaign_id, batch_size? }
// Dials pending patients sequentially-ish with AMD enabled and creates a
// call_log row per call so tool webhooks can resolve context by call_control_id.
//
// MVP note: this dials one small batch per invocation. For production pacing,
// schedule this function with pg_cron / Supabase scheduled functions and add
// concurrency + calling-hours guards.

import { supabase, telnyx, json, corsHeaders } from "../_shared/lib.ts";

const CONNECTION_ID = Deno.env.get("TELNYX_CONNECTION_ID")!; // Call Control App ID
const FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;

Deno.serve(async (req) => {
  // Browsers send a CORS preflight (OPTIONS) before the POST from the portal.
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  // Require a logged-in staff member (anon key + user JWT from the portal)
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401, corsHeaders());

  const { campaign_id, batch_size = 3 } = await req.json();
  if (!campaign_id) return json({ error: "campaign_id required" }, 400, corsHeaders());

  const { data: campaign } = await supabase.from("campaigns")
    .select("*").eq("id", campaign_id).single();
  if (!campaign) return json({ error: "campaign not found" }, 404, corsHeaders());

  // Status machine (§2.5): only 'active' campaigns dial. Pause is respected
  // immediately because the dialer refuses to pick up new patients here.
  if (campaign.status !== "active") {
    return json({ started: 0, message: `campaign is ${campaign.status}, not active` }, 200, corsHeaders());
  }

  // Calling-hours gate (§4.4): exit quietly outside the clinic's local window.
  const { data: withinHours } = await supabase.rpc("clinic_within_calling_hours", {
    p_clinic_id: campaign.clinic_id,
  });
  if (withinHours === false) {
    return json({ started: 0, message: "outside clinic calling hours" }, 200, corsHeaders());
  }

  // Pending patients + callbacks that are now due.
  // DNC/inactive exclusion happens at query level, not just in the UI (§4.2).
  const { data: queue } = await supabase.from("campaign_patients")
    .select("patient_id, status, attempts, callback_after, patients!inner(*)")
    .eq("campaign_id", campaign_id)
    .eq("patients.do_not_call", false)
    .eq("patients.active", true)
    .or(`status.eq.pending,and(status.eq.callback_requested,callback_after.lte.${new Date().toISOString()})`)
    .limit(batch_size);

  if (!queue?.length) {
    // Auto-complete when nothing remains in pending/callback states (§2.5).
    const { count } = await supabase.from("campaign_patients")
      .select("patient_id", { count: "exact", head: true })
      .eq("campaign_id", campaign_id)
      .in("status", ["pending", "calling", "callback_requested"]);
    if (!count) {
      await supabase.from("campaigns").update({ status: "completed" }).eq("id", campaign_id);
    }
    return json({ started: 0, message: "no pending patients" }, 200, corsHeaders());
  }

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
      // The appointment/campaign type is NOT sent to the AI — it only selects
      // which Telnyx assistant answers. That assistant already embeds the
      // type-specific behaviour in its own prompt.
      assistant_id: campaign.telnyx_assistant_id ?? null,
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
          clinic_id: campaign.clinic_id,
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

  return json({ started }, 200, corsHeaders());
});
