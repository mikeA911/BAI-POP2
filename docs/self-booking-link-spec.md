# Self-Service Booking Link — Feature Spec

**Date:** July 6, 2026 · **Status:** Approved for implementation
**Related:** precall-sms-implementation-note.md · portal-ui-roles-spec.md §2.5, §4.2
**Supersedes:** the exploratory SMS-chat booking concept (kept for possible later use for patients who reply to texts; the link is the primary self-serve path).

## 1. Summary

Every outreach SMS may carry a short link to a public booking page. The patient opens it, verifies their date of birth, sees available slots for their provider, and books — using the SAME server-side rules as the AI voice flow (slot generation, verification lockout, idempotent booking, double-booking exclusion). Booking via the link automatically prevents the pending AI call: the status transition to `booked` removes the patient from the dialer's queue with no additional coordination code.

Patient journeys:
* **Voicemail fallback** (primary win): unreached patient gets "We tried to call you about scheduling. Book a time that works for you here: {link}" — converts the largest dead-end outcome bucket into self-serve bookings, 24/7.
* **Pre-call SMS** (secondary): "…we'll call you in about N minutes — or book yourself now: {link}". Campaigns using this should consider a longer lead (5–10 min) so booking can pre-empt the call.

## 2. Schema

```sql
create table booking_links (
  id uuid primary key default uuid_generate_v4(),
  token_hash text not null unique,          -- sha256 of the URL token; raw token never stored
  campaign_id uuid not null references campaigns(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  clinic_id uuid references clinics(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,          -- default now() + 7 days
  verification_attempts int not null default 0,
  verified_at timestamptz,
  booked_appointment_id uuid references appointments(id),
  locked boolean not null default false     -- true after verification failures
);
create index on booking_links (campaign_id, patient_id);
```

Also add the cross-channel double-booking guard (see §7): a partial unique index `on appointments (patient_id, campaign_id) where status in ('booked','confirmed')`, plus `appointments.source text default 'voice'`.

Rules: one ACTIVE link per (campaign, patient) — creating a new one expires priors. RLS: staff read for own clinic (debug/support); no client writes; all writes via edge functions (service role).

## 3. Token & URL

128-bit random, base64url (~22 chars): `https://<portal-domain>/book/<token>`. Only the SHA-256 hash is stored; a leaked database therefore doesn't leak usable links. Consider a link-shortener style path if SMS length matters (the token URL fits comfortably in one segment with the current copy). Expiry: 7 days default. After booking, the link resolves to a confirmation view (read-only), not a second booking.

## 4. Public API — new edge function `booking-api`

Public (JWT verification OFF; abuse controls below). All responses PHI-minimal until verified. Endpoints via `?action=`:

* **`context`** `{ token }` → `{ clinic_name, appointment_type_label, state: "needs_verification" | "ready" | "booked" | "expired" | "locked" }`. Never returns patient name/DOB status detail beyond `state`.
* **`verify`** `{ token, stated_date_of_birth }` → server-side compare against the record, mirroring assistant-tools: 2 attempts max, then `locked=true` AND `campaign_patients` → `needs_human` (flag_reason "booking link verification failed"). Success sets `verified_at` and returns `{ verified: true, first_name }` (first name only — the one PHI element shown, post-verification).
* **`slots`** `{ token, granularity, on_date? }` → requires verified link; calls the SAME `get_available_slots` RPC with the clinic's `p_tz`. Web can show more than 3 (it's a screen, not speech) — return up to 10 days / all times for a chosen day.
* **`book`** `{ token, slot_start }` → requires verified link; inserts the appointment with idempotency_key = `link:{link_id}:{slot_start}` (same pattern as voice; the exclusion constraint still guarantees no double-booking); flips `campaign_patients` to `booked`; stamps `booked_appointment_id`; writes a `call_logs`-equivalent record? NO — instead add `source` to appointments (`'voice' | 'booking_link'`, default `'voice'`) so reporting can distinguish channels without faking a call log.
* **`decline`** `{ token, callback? }` (optional v1.1): "None of these work — call me instead" button → `callback_requested`.

Abuse controls: per-token attempt lockout (above) + basic per-IP rate limit on `verify` (e.g., 10/min via a simple counter table or upstream WAF); invalid tokens return the same generic "link expired or invalid" as expired ones (no oracle).

## 5. Link generation & SMS copy changes

`start-campaign` (pre-call SMS) and `telnyx-call-events` (voicemail SMS) both: create/refresh a booking link for the (campaign, patient) and append to the message. Gate behind clinic setting `clinics.self_booking_enabled boolean default false` so rollout is per-clinic. Copy:

* Pre-call: `Hi {first}, this is {clinic}. We'll call you in about {n} minutes from this number to help schedule an appointment — or book yourself now: {link}. Reply STOP to opt out.`
* Voicemail: `Hi, this is {clinic}. We tried to reach you about scheduling an appointment. Pick a time that works for you: {link}. Reply STOP to opt out.`

SMS consent gating from precall-sms-implementation-note §3.3 applies unchanged.

## 6. Frontend — public route in the portal app

`/book/:token` outside the auth guard. Flow: clinic-branded shell (name only) → DOB entry (date input, not free text) → day picker → time picker → confirm screen ("Tuesday, July 14 at 10:00 AM with Dr. Jones") → success with "You'll receive a reminder before your visit". States for expired/locked/already-booked. Mobile-first (nearly 100% of traffic arrives from SMS), large touch targets, no login, no cookies beyond essentials. Do not render the patient's full name, phone, or DOB anywhere. Timezone: display in the clinic's timezone with an explicit label ("all times US Central").

## 7. Interplay with the dialer & double-booking guard

**Call cancellation is free.** Booked-via-link patients leave `notified`/`pending`, so Phase B never dials them and sweeps never re-text them — the state transition IS the cancellation; build no extra coordination.

**Same-slot race is already resolved.** If web and voice race for the SAME slot, the provider exclusion constraint lets one insert win; the loser receives `slot_taken` and re-fetches. Accept as-is.

**Different-slot race requires ONE new guard.** Neither booking path currently checks whether the patient already holds an appointment for this campaign, so a patient answering the call while someone completes the web flow can end up with TWO appointments at different times. Close this at the database level so every present and future channel inherits it:

```sql
create unique index one_active_appointment_per_campaign
  on appointments (patient_id, campaign_id)
  where status in ('booked', 'confirmed');
```

Both `create_appointment` (voice) and `book` (web) must then handle unique-violation `23505` the same way they handle `23P01`: fetch the patient's existing active appointment for the campaign and return it as an already-booked success ("You're already scheduled for {spoken}") rather than an error — that is the correct answer for the patient, not a failure. Note: cancelled/completed appointments don't block rebooking (partial index), and rescheduling flows (future) go cancel-then-book.

**Timing recommendation restated:** campaigns with `self_booking_enabled` should default the pre-call lead to 300–600 s (vs 120 s), giving the web path room to win before the phone rings.

## 8. Compliance

Same automated-SMS consent basis as existing texts. The booking page is PHI-adjacent: serve only over HTTPS (default), no analytics/third-party scripts on the page, no PHI in URLs beyond the opaque token, no PHI pre-verification, first-name-only post-verification. Booking confirmations should not include diagnosis/visit-reason details beyond the campaign's public label ("Annual wellness visit").

## 9. Phasing & tests

Build order: schema + `booking-api` (context/verify/slots/book) → public route UI → link injection in voicemail SMS (behind clinic flag) → link in pre-call SMS → optional `decline` action.

Test checklist: (1) happy path books and the pending call never fires; (2) two wrong DOBs → locked, review-queue item created, page shows locked state; (3) expired token → generic invalid message; (4) book the last slot from web while voice call books the same slot → one wins, other gets slot_taken; (5) link reused after booking → confirmation view, no rebooking; (6) clinic flag off → SMS contains no link; (7) DNC/no-consent patient → no SMS at all (existing rules); (8) slots render in clinic timezone on a device set to another timezone; (9) voice books slot A while web books slot B for the same patient/campaign → exactly ONE appointment exists, the losing channel reports "already scheduled" with the winning time.
