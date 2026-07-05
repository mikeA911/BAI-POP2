# CareCall — AI Outbound Appointment Scheduling

Web platform that lets clinic staff run outbound scheduling campaigns. Telnyx AI Voice Assistants make the calls; Supabase is the single source of truth for patients, availability, appointments, and outcomes.

```
Clinic staff → React portal → Supabase (DB + Edge Functions) ⇄ Telnyx AI Voice Assistant → Patient
```

## Call flow (enforced by code, not just the prompt)

1. **AMD gate** — calls are dialed with premium answering-machine detection. The AI assistant is only started on the call after Telnyx classifies the answer as a live human. Voicemail gets a brief PHI-free callback message + SMS fallback, handled entirely by the `telnyx-call-events` function.
2. **Identity verification** — the AI collects a stated date of birth and calls `verify_patient`; the comparison happens **server-side** and the AI only ever sees match / no-match. Two failures locks the call and flags the patient `verification_failed` for human follow-up. Scheduling tools return 403 until the call is verified.
3. **Progressive slot disclosure** — `get_appointment_slots` returns at most 3 days, then at most 3 times for a chosen day, with speech-ready strings so the AI can't invent times.
4. **Explicit confirmation** — `create_appointment` is idempotent (retries can't double-book) and a Postgres exclusion constraint makes provider double-booking impossible at the database level.
5. **No forced bookings** — `mark_outcome` records declined / callback_requested / wrong_number / needs_human, and callbacks re-enter the dial queue after their `callback_after` time.

## Repository layout

```
carecall/
├── supabase/
│   ├── migrations/          # schema, slot-generation function, RLS, seed
│   └── functions/
│       ├── _shared/         # supabase + telnyx clients, helpers
│       ├── start-campaign/  # dials pending patients with AMD enabled
│       ├── telnyx-call-events/  # Call Control webhook: AMD, voicemail, hangup
│       └── assistant-tools/ # verify_patient, get_appointment_slots, create_appointment, mark_outcome
├── telnyx/
│   ├── assistant-instructions.md  # paste into the Telnyx AI Assistant
│   └── tools.json                 # webhook tool definitions to register
└── web/                     # React (Vite + TS) staff portal
```

---

## 0. Prerequisites

- Node.js 20+ and Git
- VS Code
- A [Supabase](https://supabase.com) project
- A [Telnyx](https://telnyx.com) account with: a purchased phone number, a **Call Control Application** (a.k.a. Voice API app), an **AI Assistant**, and optionally a Messaging Profile for the SMS fallback
- Supabase CLI: `npm i -g supabase`
- GitHub CLI (optional but easiest): `gh`

## 1. Open the workspace in VS Code

```bash
cd carecall
code .
```

Recommended extensions: **Deno** (for `supabase/functions` — enable it per-workspace only for that folder), **ESLint**, **Prettier**. A `.vscode/settings.json` is included that scopes Deno to the functions directory so it doesn't fight the React app's TypeScript.

## 2. Create the GitHub repository

With GitHub CLI:

```bash
git init
git add .
git commit -m "CareCall: initial scaffold — schema, edge functions, Telnyx assistant config, staff portal"
gh repo create carecall --private --source=. --push
```

Without the CLI: create an empty private repo at github.com/new, then:

```bash
git init
git add .
git commit -m "CareCall: initial scaffold"
git remote add origin git@github.com:<you>/carecall.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `.env`, `node_modules`, and build output. **Never commit real patient data or API keys.**

## 3. Set up Supabase

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push                # applies migrations (schema + seed provider)
```

Set function secrets (server-side only — never exposed to the browser):

```bash
supabase secrets set \
  TELNYX_API_KEY=KEY_xxx \
  TELNYX_CONNECTION_ID=<call control app id> \
  TELNYX_ASSISTANT_ID=<assistant id> \
  TELNYX_FROM_NUMBER=+1XXXXXXXXXX \
  TELNYX_MESSAGING_PROFILE_ID=<optional, for SMS fallback> \
  TOOL_WEBHOOK_SECRET=<generate: openssl rand -hex 32> \
  CLINIC_NAME="River Valley Family Clinic" \
  CLINIC_CALLBACK_NUMBER=+1XXXXXXXXXX \
  CLINIC_TZ=America/Chicago
```

Deploy the functions:

```bash
supabase functions deploy start-campaign
supabase functions deploy telnyx-call-events --no-verify-jwt
supabase functions deploy assistant-tools --no-verify-jwt
```

(`--no-verify-jwt` because Telnyx calls those two directly; they're protected by the shared secret / always-200 webhook pattern instead. `telnyx-call-events` should additionally verify Telnyx webhook signatures before production — see Hardening below.)

## 4. Set up Telnyx

1. **Call Control Application** — set the webhook URL to
   `https://<PROJECT_REF>.supabase.co/functions/v1/telnyx-call-events`
   and enable **Answering Machine Detection: Premium**.
2. **AI Assistant** — create one, paste `telnyx/assistant-instructions.md` into its instructions, pick a voice, and register the four tools from `telnyx/tools.json` (replace `<PROJECT_REF>` and `<TOOL_WEBHOOK_SECRET>`). Set the assistant's insights/transcript webhook to the same events URL if you want transcripts stored.
3. Assign your outbound phone number to the Call Control Application.

## 5. Run the staff portal

```bash
cd web
cp .env.example .env        # fill in your Supabase URL + anon key
npm install
npm run dev
```

Enable **Email auth** in Supabase and create a staff user (the portal relies on RLS: only authenticated users can read/write). For the MVP you can sign in via the Supabase dashboard-generated magic link; adding a login screen is a small follow-up.

## 6. Smoke test

1. Portal → Campaigns → create "Annual Wellness Visits" with a greeting context.
2. Portal → Patients → add yourself (your real mobile, your DOB).
3. Assign yourself to the campaign, then Dashboard → **Start calling**.
4. Answer the call: confirm your name, state your DOB, pick a slot, confirm.
5. Watch the Live activity feed flip you to **booked**, and check Call history.
6. Call again and let it hit voicemail to verify the AMD path (message + SMS, no AI).

## Hardening before production (important for healthcare)

- **BAA / HIPAA**: patient names, phones, DOBs, and call recordings are PHI. Execute BAAs with both Supabase and Telnyx (both offer them on qualifying plans) before using real patient data.
- **Webhook signature verification**: verify Telnyx's `telnyx-signature-ed25519` header in `telnyx-call-events` instead of trusting any POST.
- **Calling hours & pacing**: gate `start-campaign` to local business hours and add per-minute pacing (TCPA and state robocall rules apply to healthcare reminder calls — confirm your consent basis for each patient list).
- **Retry policy**: schedule `start-campaign` via Supabase cron to automatically retry `no_answer`/`voicemail` patients with attempt caps.
- **Recordings**: if you enable call recording, store URLs in `call_logs.recording_url` and restrict access.
- **Audit**: RLS is currently "any authenticated staff member"; tighten to roles if multiple clinics share an instance.

## The campaign-engine idea

The schema already treats scheduling as just the first campaign type: a campaign is (who to call, why, which provider calendars, which tools, what outcome). Medication adherence, care-gap outreach, intake, and surveys are new rows in `campaigns` plus new prompt/tool sets — no architectural change.
