// CareCall — Telnyx Call Control event webhook.
//
// Implements the AMD gate from the call-flow spec:
//   1. Dial with answering_machine_detection: "premium".
//   2. On call.machine.detection.ended:
//        - human    → start the AI assistant on the call
//        - machine  → wait for call.machine.greeting.ended, speak a brief
//                     callback message, send an SMS, hang up. Never start the AI.
//   3. On call.hangup → finalize the call log and campaign_patient status.
//
// Set this function's URL as the webhook for your Call Control Application.

import { supabase, telnyx, json } from "../_shared/lib.ts";

const ASSISTANT_ID = Deno.env.get("TELNYX_ASSISTANT_ID")!;
const FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;
const MESSAGING_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "";
const CLINIC_NAME = Deno.env.get("CLINIC_NAME") ?? "your clinic";
const CALLBACK_NUMBER = Deno.env.get("CLINIC_CALLBACK_NUMBER") ?? FROM_NUMBER;

Deno.serve(async (req) => {
  const event = await req.json().catch(() => null);
  if (!event?.data) return json({ ok: true });

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
          await telnyx(`/calls/${ccid}/actions/ai_assistant_start`, {
            assistant: { id: ASSISTANT_ID },
            // Give the assistant per-call variables (never the DOB on file)
            dynamic_variables: {
              patient_first_name: state?.patient_first_name ?? "",
              campaign_context: state?.campaign_context ?? "",
              clinic_name: CLINIC_NAME,
            },
          });
        }
        // machine → do nothing here; wait for greeting to end before speaking
        break;
      }

      case "call.machine.greeting.ended": {
        // Leave a brief, PHI-free callback message after the beep-ish moment
        await telnyx(`/calls/${ccid}/actions/speak`, {
          voice: "female",
          language: "en-US",
          payload:
            `Hello, this is ${CLINIC_NAME} calling with a scheduling reminder. ` +
            `Please call us back at ${spellNumber(CALLBACK_NUMBER)} at your convenience. Thank you.`,
        });
        break;
      }

      case "call.speak.ended": {
        // Voicemail message finished → send SMS fallback, mark, hang up
        if (state?.patient_id && state?.campaign_id) {
          await markUnreached(state.campaign_id, state.patient_id, ccid, "voicemail");
          if (MESSAGING_PROFILE_ID && state.patient_phone) {
            await telnyx(`/messages`, {
              from: FROM_NUMBER,
              to: state.patient_phone,
              messaging_profile_id: MESSAGING_PROFILE_ID,
              text:
                `Hi, this is ${CLINIC_NAME}. We called to help you schedule an appointment. ` +
                `Please call us at ${CALLBACK_NUMBER} and we'll find a time that works.`,
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
      .in("status", ["pending", "calling"]),
    supabase.from("call_logs").update({ result: kind }).eq("call_control_id", ccid),
  ]);
}

/** "+15551234567" → "5 5 5, 1 2 3, 4 5 6 7" so TTS reads it clearly. */
function spellNumber(e164: string): string {
  const d = e164.replace(/\D/g, "").replace(/^1/, "");
  return `${d.slice(0, 3).split("").join(" ")}, ${d.slice(3, 6).split("").join(" ")}, ${d.slice(6).split("").join(" ")}`;
}
