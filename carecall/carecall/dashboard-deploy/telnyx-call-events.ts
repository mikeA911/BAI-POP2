// telnyx-call-events — DASHBOARD-DEPLOY VERSION (shared helpers inlined, no _shared import)
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


const ASSISTANT_ID = Deno.env.get("TELNYX_ASSISTANT_ID")!;
const FROM_NUMBER = Deno.env.get("TELNYX_FROM_NUMBER")!;
const MESSAGING_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "";
const CLINIC_NAME = Deno.env.get("CLINIC_NAME") ?? "your clinic";
const CALLBACK_NUMBER = Deno.env.get("CLINIC_CALLBACK_NUMBER") ?? FROM_NUMBER;

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
  return Boolean(p && (p.insight_results || p.insights || p.results) );
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
