# Pre-Call SMS Notification — Implementation Note for Dev Team

**Date:** July 6, 2026 · **Status:** Backend shipped & deployed; portal/settings integration needed
**Related:** portal-ui-roles-spec.md §2.5 (campaign lifecycle), §4.4 (calling hours), §4.2 (DNC)

## 1. What the feature does

Before the AI dials a patient, the system texts them a heads-up ("Hi {first_name}, this is {clinic}. We'll be calling you in about 2 minutes from this number… Reply STOP to opt out."), waits a configurable lead time (default 120 s), then places the call. Purpose: unknown-number calls get screened; a text from the same number two minutes prior materially improves answer rates.

## 2. What is ALREADY implemented (do not rebuild)

**Schema** (migrations `20260706000000/1`, applied in prod):
`campaign_patient_status` gained value `'notified'`; `campaign_patients.dial_after timestamptz` added; `campaign_stats` view counts `notified` inside `pending` ("in queue").

**Function** (`start-campaign`, merged version, deployed): a two-phase queue per invocation — Phase B first dials rows in `notified` whose `dial_after <= now()` (so notifications never starve dials), then Phase A sends the SMS to the next `pending`/due-callback batch and stamps `status='notified'`, `dial_after = now() + lead`. The patient lifecycle is now `pending → notified → calling → <outcome>`.

Also already handled: **sweep mode** (`{"sweep": true}`) advancing all active campaigns for the cron heartbeat; DNC/inactive filters re-checked in BOTH phases (a patient can text STOP during their countdown); auto-complete counts `notified` as in-flight; SMS send failure falls back to dialing immediately; feature disables cleanly (straight-to-dial) when `TELNYX_MESSAGING_PROFILE_ID` is unset or lead = 0; clinic display name read from `clinics` with env fallback; `markUnreached` in `telnyx-call-events` accepts status `notified` (event-vs-status-update race).

**Ops:** a Supabase Cron job invokes `start-campaign` every minute with `{"sweep": true}`. Timing consequence: actual lead ≈ 2–3 min with a 1-minute tick. This is fine; the SMS says "about".

## 3. What the dev team implements

### 3.1 UI: the `notified` state (Phase 2 work)

Live activity feed, campaign detail, and patient detail must render the new status. Suggested badge style: the callback_requested blue family, label "Text sent". Nice-to-have on campaign detail: show `dial_after` relative time ("calling in ~1 min"). The status flows through the existing realtime subscription — no new plumbing.

### 3.2 Per-clinic lead time (Phase 3, clinic settings page)

Move the knob from env to data, same pattern as §5: add `clinics.sms_precall_lead_seconds int` (null = use env default; 0 = feature off for this clinic). `start-campaign` reads it per campaign's clinic with the env value as fallback. Surface in /settings/clinic as "Pre-call text message" with a short explanation and an on/off + seconds control (sensible bounds: 60–600).

### 3.3 SMS consent gating (Phase 3, patients)

Alongside the DNC flag (§4.2), add `patients.sms_consent boolean not null default false` and surface it in CSV import + patient detail. Rule: **no consent → skip the SMS, dial directly** (voice and SMS have separate consent bases; absence of SMS consent must not block the call, and must not queue an automated text). Implement as a condition in Phase A. Also applies to the voicemail-fallback SMS in `telnyx-call-events` — same flag, same rule. CSV column name: `sms_consent` (true/1/yes accepted).

### 3.4 Stale-`notified` recovery guard (small, but do it)

Failure mode: the SMS goes out, but every subsequent dial attempt errors (Telnyx outage, bad number that texts but won't dial). `dialPatient` returns false without incrementing attempts, so the row sits in `notified` and Phase B retries it every sweep tick — worst case an endless dial loop after a single text. Guard: in Phase B, if `dial_after < now() - interval '30 minutes'`, stop retrying — set status `needs_human`, flag_reason "dial failed after pre-call SMS", and let the review queue surface it. Thirty minutes ≈ 30 retry ticks, generous for transient errors.

### 3.5 Message copy per clinic (defer unless asked)

Copy is currently hardcoded (with clinic name interpolated). If clinics later want custom wording, add `clinics.sms_precall_template` with `{first_name}`/`{clinic_name}` placeholders — but do not build this speculatively; the compliant default copy (identifies clinic, states purpose, includes STOP language) is deliberately conservative and custom templates create a compliance review burden per clinic.

## 4. Compliance notes (context, not optional)

The pre-call text is an automated SMS: TCPA express-consent rules apply independently of call consent — hence §3.3. The hardcoded copy includes "Reply STOP to opt out"; Telnyx processes STOP automatically at the carrier level, but our `do_not_call`/`sms_consent` flags are the application-level record and the review queue's "Do not call" action must set them. The 10DLC campaign registration for the sending number must list this heads-up use case.

## 5. Test checklist

1. Patient in `pending`, active campaign, inside calling hours → receives SMS, status `notified`, `dial_after` ≈ now+120 s → call arrives on the next sweep tick after `dial_after` → status `calling`.
2. Patient texts STOP (or DNC set) during countdown → Phase B does not dial (verify row untouched by dialer; define with product whether it should revert to `pending` or resolve as declined — current behavior: it sits until the §3.4 guard flags it, which is acceptable but worth a deliberate decision).
3. `sms_consent=false` → no SMS, dialed directly (once §3.3 lands).
4. Messaging profile secret removed → whole feature bypasses, straight-to-dial.
5. Campaign with all patients in `notified` → not auto-completed.
6. Outside clinic calling hours → sweep skips the campaign entirely (neither texts nor calls).
7. Force a dial failure (invalid number that accepts SMS) → §3.4 guard flags to review queue within ~30 min instead of looping forever.
