// CareCall — Telnyx Call Control event webhook.
// MERGED 2026-07-06: dev-team multi-clinic version (clinicForCall, per-campaign
// assistant routing, sms_fallback toggle) + restored INSIGHTS handler (was lost
// in the debug fork: transcripts/summaries were not being stored) + 'notified'
// added to markUnreached statuses (pre-call SMS race).
//
// Implements the AMD gate from the call-flow spec:
//   1. Dial with answering_machine_detection: "premium".
//   2. On call.machine.detection.ended:
//        - human    → start the AI assistant on the call
//        - machine  → wait for call.machine.greeting.ended, speak a brief
//                     callback message, send an SMS, hang up. Never start the AI.
//   3. On call.hangup → finalize the call log and campaign_patient status.
// Also receives the assistant's post-call Insights webhook on this same URL.

import { supabase, telnyx, json, createBookingLink } from "../_shared/lib.ts";

const ASSISTANT_ID = Deno.env.get("TELNYX_ASSISTANT_ID")!;
const FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;
const MESSAGING_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "";
// Env values remain as fallback defaults (§5). Per-clinic values are read from
// the clinics row via the call's campaign so one deployment serves many clinics.
const DEFAULT_CLINIC_NAME = Deno.env.get("CLINIC_NAME") ?? "your clinic";
const DEFAULT_CALLBACK_NUMBER = Deno.env.get("CLINIC_CALLBACK_NUMBER") ?? FROM_NUMBER;

/** Resolve clinic name + callback number for a call, via call_logs → campaign → clinic. */
async function clinicForCall(ccid: string): Promise<{ id: string | null; name: string; callback: string; smsFallback: boolean; selfBooking: boolean }> {
  const { data } = await supabase.from("call_logs")
    .select("clinic_id, clinics(name, phone_callback, sms_fallback, self_booking_enabled)")
    .eq("call_control_id", ccid).maybeSingle();
  const row = data as { clinic_id?: string | null; clinics?: { name?: string; phone_callback?: string; sms_fallback?: boolean; self_booking_enabled?: boolean } } | null;
  const clinic = row?.clinics;
  return {
    id: row?.clinic_id ?? null,
    name: clinic?.name ?? DEFAULT_CLINIC_NAME,
    callback: clinic?.phone_callback ?? DEFAULT_CALLBACK_NUMBER,
    smsFallback: clinic?.sms_fallback ?? true,
    selfBooking: clinic?.self_booking_enabled ?? false,
  };
}

/** Whether a patient has given SMS consent (§3.3). Missing row → treated as no. */
async function patientSmsConsent(patientId: string): Promise<boolean> {
  const { data } = await supabase.from("patients")
    .select("sms_consent").eq("id", patientId).maybeSingle();
  return (data as { sms_consent?: boolean } | null)?.sms_consent === true;
}

Deno.serve(async (req) => {
  const event = await req.json().catch(() => null);
  if (!event?.data) return json({ ok: true });

  // Insights arrive on this same URL but aren't call-control events
  if (looksLikeInsights(event)) {
    try { await handleInsights(event); } catch (e) { console.error("insights handling failed", e); }
    return json({ ok: true });
  }

  const type: string = event.data.event_type;
  const payload = event.data.payload ?? {};
  const ccid: string = payload.call_control_id;
  // client_state carries {campaign_id, patient_id} base64-encoded from dial time
  const state = decodeState(payload.client_state);

  try {
    switch (type) {
      case "call.answered": {
        // Don't start the AI yet — wait for AMD result. Just log.
        await supabase.from("call_logs").update({ started_at: new Date().toISOString() })
          .eq("call_control_id", ccid);
        break;
      }

      case "call.machine.detection.ended": {
        const result: string = payload.result; // 'human' | 'machine' | 'not_sure'
        await supabase.from("call_logs").update({ amd_result: result }).eq("call_control_id", ccid);

        if (result === "human" || result === "not_sure") {
          // Treat not_sure as human — worst case the AI greets a voicemail and
          // the silence-timeout ends the call. Start the AI assistant.
          const clinic = await clinicForCall(ccid);
          // Route to the per-appointment-type assistant chosen at campaign
          // creation, falling back to the env default when none is set.
          const assistantId = state?.assistant_id || ASSISTANT_ID;
          await telnyx(`/calls/${ccid}/actions/ai_assistant_start`, {
            assistant: { id: assistantId },
            // Give the assistant per-call variables (never the DOB on file).
            // appointment_type is intentionally omitted: the chosen assistant
            // already encodes the type-specific behaviour in its own prompt.
            dynamic_variables: {
              patient_first_name: state?.patient_first_name ?? "",
              campaign_context: state?.campaign_context ?? "",
              clinic_name: clinic.name,
            },
          });
        }
        // machine → do nothing here; wait for greeting to end before speaking
        break;
      }

      case "call.machine.greeting.ended": {
        // Leave a brief, PHI-free callback message after the beep-ish moment
        const clinic = await clinicForCall(ccid);
        await telnyx(`/calls/${ccid}/actions/speak`, {
          voice: "female",
          language: "en-US",
          payload:
            `Hello, this is ${clinic.name} calling with a scheduling reminder. ` +
            `Please call us back at ${spellNumber(clinic.callback)} at your convenience. Thank you.`,
        });
        break;
      }

      case "call.speak.ended": {
        // Voicemail message finished → send SMS fallback, mark, hang up
        if (state?.patient_id && state?.campaign_id) {
          await markUnreached(state.campaign_id, state.patient_id, ccid, "voicemail");
          const clinic = await clinicForCall(ccid);
          // Voicemail-fallback SMS requires SMS consent, same rule as the
          // pre-call text (§3.3). No consent → skip the text (call already made).
          const smsConsent = await patientSmsConsent(state.patient_id);
          if (MESSAGING_PROFILE_ID && state.patient_phone && clinic.smsFallback && smsConsent) {
            // Voicemail-fallback SMS. When self-booking is enabled for the
            // clinic (and a booking link can be minted), send the self-serve
            // copy with the link — the primary win: converting the largest
            // dead-end bucket into 24/7 self bookings. Otherwise fall back to
            // the classic "please call us" copy.
            let text =
              `Hi, this is ${clinic.name}. We called to help you schedule an appointment. ` +
              `Please call us at ${clinic.callback} and we'll find a time that works.`;
            if (clinic.selfBooking) {
              const link = await createBookingLink(state.campaign_id, state.patient_id, clinic.id);
              if (link) {
                text =
                  `Hi, this is ${clinic.name}. We tried to reach you about scheduling an ` +
                  `appointment. Pick a time that works for you: ${link}. Reply STOP to opt out.`;
              }
            }
            await telnyx(`/messages`, {
              from: FROM_NUMBER,
              to: state.patient_phone,
              messaging_profile_id: MESSAGING_PROFILE_ID,
              text,
            }).catch((e) => console.error("SMS failed", e));
          }
        }
        await telnyx(`/calls/${ccid}/actions/hangup`, {});
        break;
      }

      case "call.hangup": {
        const { data: log } = await supabase.from("call_logs")
          .select("id, result, started_at, campaign_id, patient_id")
          .eq("call_control_id", ccid).single();
        if (log) {
          const duration = log.started_at
            ? Math.round((Date.now() - new Date(log.started_at).getTime()) / 1000) : null;
          await supabase.from("call_logs")
            .update({ ended_at: new Date().toISOString(), duration_seconds: duration })
            .eq("id", log.id);
          // If the call ended with no recorded result, it was a no-answer/drop
          if (!log.result && log.campaign_id && log.patient_id) {
            await markUnreached(log.campaign_id, log.patient_id, ccid, "no_answer");
          }
        }
        break;
      }
    }
  } catch (e) {
    console.error(`event ${type} handling failed`, e);
  }

  return json({ ok: true }); // always 200 so Telnyx doesn't retry forever
});

function decodeState(cs?: string): Record<string, string> | null {
  if (!cs) return null;
  try { return JSON.parse(atob(cs)); } catch { return null; }
}

async function markUnreached(campaignId: string, patientId: string, ccid: string, kind: "voicemail" | "no_answer") {
  await Promise.all([
    supabase.from("campaign_patients")
      .update({ status: kind, updated_at: new Date().toISOString() })
      .eq("campaign_id", campaignId).eq("patient_id", patientId)
      // 'notified' included: a call event can land before start-campaign's
      // status flip to 'calling' commits (pre-call SMS two-phase queue).
      .in("status", ["pending", "notified", "calling"]),
    supabase.from("call_logs").update({ result: kind }).eq("call_control_id", ccid),
  ]);
}

/** "+15551234567" → "5 5 5, 1 2 3, 4 5 6 7" so TTS reads it clearly. */
function spellNumber(e164: string): string {
  const d = e164.replace(/\D/g, "").replace(/^1/, "");
  return `${d.slice(0, 3).split("").join(" ")}, ${d.slice(3, 6).split("").join(" ")}, ${d.slice(6).split("").join(" ")}`;
}

// ------------------------------------------------------------------
// INSIGHTS: post-call results from the assistant's Insights webhook.
// Telnyx's payload shape varies by configuration, so this parser is
// deliberately tolerant: it hunts for the call_control_id and the
// insight results wherever they appear, and logs anything it can't
// recognize so the shape can be confirmed from real traffic.
// ------------------------------------------------------------------
function looksLikeInsights(evt: Record<string, unknown>): boolean {
  const t = String((evt?.data as Record<string, unknown>)?.event_type ?? evt?.event_type ?? "");
  if (t.includes("insight")) return true;
  const p = ((evt?.data as Record<string, unknown>)?.payload ?? evt) as Record<string, unknown>;
  return Boolean(p && (p.insight_results || p.insights || p.results));
}

function deepFind(obj: unknown, keys: string[], depth = 0): unknown {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k) && v != null) return v;
    const found = deepFind(v, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function handleInsights(evt: Record<string, unknown>) {
  const ccid = deepFind(evt, ["call_control_id", "telnyx_call_control_id"]) as string | undefined;
  if (!ccid) {
    console.warn("insights: no call_control_id found; raw payload:", JSON.stringify(evt).slice(0, 2000));
    return;
  }

  const rawResults = deepFind(evt, ["insight_results", "insights", "results"]);
  const list: { name?: string; insight_name?: string; result?: unknown; value?: unknown }[] =
    Array.isArray(rawResults) ? rawResults
    : rawResults && typeof rawResults === "object" ? Object.entries(rawResults).map(([k, v]) => ({ name: k, result: v }))
    : [];

  let summary: string | null = null;
  let outcomeObj: Record<string, unknown> | null = null;
  for (const item of list) {
    const name = (item.name ?? item.insight_name ?? "").toString();
    const val = item.result ?? item.value;
    if (name === "call_summary" && typeof val === "string") summary = val;
    if (name === "call_outcome") {
      if (typeof val === "object" && val) outcomeObj = val as Record<string, unknown>;
      else if (typeof val === "string") {
        try { outcomeObj = JSON.parse(val.replace(/```json|```/g, "").trim()); } catch { /* keep raw in transcript */ }
      }
    }
  }

  // Transcript: use conversation messages if the payload carries them,
  // otherwise store the raw insight results for the Call History pane.
  const messages = deepFind(evt, ["messages", "transcript"]);
  const transcript = messages ?? { insights: rawResults ?? evt };

  const update: Record<string, unknown> = { transcript };
  if (summary) update.summary = summary;

  await supabase.from("call_logs").update(update).eq("call_control_id", ccid);

  // Outcome from insights is a FALLBACK only — never overwrite a result
  // already recorded by the tools (booked, declined, etc.).
  const validResults = ["booked", "declined", "callback_requested", "no_answer", "voicemail", "wrong_number", "verification_failed", "transferred", "error"];
  const insightOutcome = String(outcomeObj?.outcome ?? "");
  const mapped = insightOutcome === "needs_human" ? "transferred" : insightOutcome;
  if (validResults.includes(mapped)) {
    const { data: log } = await supabase.from("call_logs")
      .select("id, result").eq("call_control_id", ccid).single();
    if (log && !log.result) {
      await supabase.from("call_logs").update({ result: mapped }).eq("id", log.id);
    }
  }

  if (outcomeObj?.staff_note && summary) {
    await supabase.from("call_logs")
      .update({ summary: `${summary}\n\nStaff note: ${outcomeObj.staff_note}` })
      .eq("call_control_id", ccid);
  }
}
