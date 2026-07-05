# CareCall Portal — UI & Roles Specification

**Version:** 1.1 · **Date:** July 5, 2026 · **Status:** Approved for development (decisions D1, D2 incorporated)
**Scope:** Staff portal UI (three role-based dashboards), the role/permission model behind it, and the schema/edge-function changes required to support it. Voice-call architecture (Telnyx/AMD/tools) is out of scope and unchanged.

---

## 1. Overview

The portal serves three user roles across one or more clinics. Every user belongs to exactly one clinic, except platform Admins, who can access all clinics. The design principle carried over from the existing system applies here too: **permissions are enforced server-side (RLS + edge functions), never by hiding buttons alone.** The UI hides what a role cannot do, but the database would reject the action regardless.

### 1.1 Naming decision (important)

The word "provider" already means a *clinician whose calendar gets booked* (the `providers` table: Dr. Jones, availability, appointments). The management role originally called "provider" in early sketches is renamed **Clinic Admin** throughout this spec and the codebase. Do not use "provider" for a user role anywhere — in code, UI copy, or tickets.

### 1.2 Roles

| Role | Scope | Summary |
|---|---|---|
| **Admin** | Platform (all clinics) | Anthropic-of-the-system. Manages clinics, all users, global settings. Can enter any clinic context and do anything a Clinic Admin can. |
| **Clinic Admin** | One clinic | Runs the clinic's outreach operation: patients, clinicians & availability, campaigns, clinic settings, and its own Staff users. |
| **Staff** | One clinic | Day-to-day operator: runs campaigns (no creation), watches live activity, works the review queue, manages own profile. |

Role and clinic are stored in `app_metadata` (`{ "role": "admin" | "clinic_admin" | "staff", "clinic_id": "<uuid>" }`), set only via the `admin-manage` edge function — never client-writable. JWTs carry both, so RLS reads them without extra queries.

### 1.3 Permission matrix

| Capability | Admin | Clinic Admin | Staff |
|---|:---:|:---:|:---:|
| Create/edit clinics | ✓ | — | — |
| Global app settings | ✓ | — | — |
| Switch clinic context | ✓ | — | — |
| Create Clinic Admin users | ✓ | — | — |
| Create Staff users | ✓ | ✓ | — |
| Reset user passwords / deactivate users | ✓ | ✓ (own clinic Staff) | — |
| Clinic settings (name, hours, greeting defaults, callback number) | ✓ | ✓ | — |
| Manage clinicians & availability | ✓ | ✓ | — |
| Add patients (manual + CSV) | ✓ | ✓ | — |
| Edit/deactivate patients, set do-not-call | ✓ | ✓ | — |
| Create campaigns | ✓ | ✓ | — |
| Run / schedule / pause campaigns | ✓ | ✓ | ✓ |
| View campaigns, live activity, call history | ✓ | ✓ | ✓ |
| Work the review queue (resolve items) | ✓ | ✓ | ✓ |
| Own profile (name, avatar, password) | ✓ | ✓ | ✓ |

---

## 2. Information architecture

Single React app, role-aware. Navigation renders per role; routes are guarded client-side for UX and server-side by RLS for security.

```
/login
/                      Dashboard (role-specific headline + activity)
/review                Review queue
/campaigns             List (draft / scheduled / active / paused / completed)
/campaigns/new         Create wizard                            [Clinic Admin+]
/campaigns/:id         Detail: live progress, patients, debug, edit
/patients              List, manual add, CSV import
/patients/:id          Patient detail: info, call history, DNC flag
/history               Call history (transcripts, summaries)
/clinicians            Clinicians & availability editor        [Clinic Admin+]
/settings/clinic       Clinic settings                          [Clinic Admin+]
/settings/users        User management                          [Clinic Admin+]
/settings/profile      Own profile & avatar                     [all]
/admin/clinics         Clinic management                        [Admin]
/admin/settings        Global settings                          [Admin]
```

### 2.1 Dashboard — Admin

Headline cards: **# Clinics** · **# Patients on file** (all clinics) · **# Patients in active campaigns** · **# Calls needing review** (all clinics, links to /review).

Below the cards: a **clinic switcher** (searchable select). **MVP note (D2):** ships as a stub — the schema and RLS are multi-clinic from Phase 1, but v1 seeds exactly one clinic and the switcher renders as a disabled single-item control behind a feature flag; enabling multi-clinic later is a UI change only. Choosing a clinic puts the Admin into that clinic's context — from that point the UI is identical to the Clinic Admin experience for that clinic, with a persistent banner showing which clinic context is active. Activity feed: recent user-management events (user created, password reset, role change, clinic created) sourced from the audit log (§4.5), interleaved with the selected clinic's operational activity.

### 2.2 Dashboard — Clinic Admin

Headline cards: **Clinic name/info** · **# Patients on file** · **# Patients in a campaign** · **# Calls needing review** (links to /review).

Activity: the live feed already built (campaign_patients realtime), plus quick actions for its role: add patients (manual/CSV), create campaign, manage clinicians, invite Staff user, clinic settings. Everything the Staff dashboard shows, plus the management entries.

### 2.3 Dashboard — Staff

Headline cards: same clinic cards as Clinic Admin (name, patients, in-campaign, needs-review). Activity: live campaign feed, quick actions limited to running/pausing campaigns and the review queue (no campaign creation). No user-management, clinician, or settings entries beyond own profile.

### 2.4 Review queue (/review) — new page, all roles

The "calls that need review" number must lead somewhere actionable. The queue lists `campaign_patients` in status `needs_human` or `verification_failed`, most recent first. Each row shows patient, campaign, flag reason, the AI's staff note (from insights), time, and links to the transcript. Row actions:

* **Mark resolved** — sets status `resolved` (new enum value), records who resolved it and when.
* **Requeue for calling** — sets status back to `pending` (or `callback_requested` with a chosen time).
* **Remove from campaign** — deletes the campaign_patients row (patient record remains).
* **Do not call** — sets the patient-level DNC flag (§4.2) and removes from all active campaigns.

An unresolved-items count badge appears in the nav for all roles.

### 2.5 Campaign lifecycle & scheduling

Campaigns gain a status machine: **draft → scheduled → active → paused → completed**. "Start calling" moves draft/scheduled → active. Pause stops the dialer picking up new patients (in-flight calls finish). A campaign auto-completes when no patients remain in pending/callback states. Scheduling: a `scheduled_start` timestamp plus recurring dial windows; a pg_cron job invokes `start-campaign` for every active campaign inside its clinic's calling hours (§4.4). The campaign detail page shows: progress bar by status, per-patient table with outcomes, live feed filtered to this campaign, a **debug tab** (recent call logs with AMD result, verification attempts, tool errors), and edit access for draft/paused campaigns.

### 2.6 Patients

Existing list/CSV/manual-add page, extended with: `do_not_call` flag surfaced prominently, per-patient detail view showing call history across campaigns, and edit/deactivate. CSV import gains a dry-run preview (parse, show row errors, then confirm) — silent partial imports have already proven confusing in testing.

### 2.7 Clinicians & availability (/clinicians) — new page, Clinic Admin+

CRUD for the `providers` table (UI label: "Clinicians") and a weekly availability grid editor writing to `provider_availability`. Times entered are clinic-local (the slot function handles timezone). Without this page, clinic admins cannot manage schedules except through SQL, which blocks real-world onboarding.

### 2.8 Settings

* **/settings/profile** (all roles): display name, avatar (Supabase Storage `avatars` bucket, image ≤ 1 MB, cropped square client-side), password change.
* **/settings/users** (Clinic Admin+): list clinic users with role and status; invite Staff (email → `admin-manage` `create_user`); reset password (admin-set temporary password via `admin-manage`); deactivate. Clinic Admins cannot create other Clinic Admins — that is Admin-only, to keep privilege escalation centralized.
* **/settings/clinic** (Clinic Admin+): clinic display name, callback phone number, timezone, calling hours (start/end per weekday), default greeting context template, SMS fallback on/off. These map to the `clinics` table (§4.1) and are read by the dialer and webhook functions instead of today's environment-variable-only configuration.
* **/admin/settings** (Admin): global defaults applied to new clinics, feature flags.

---

## 3. Auth & session behavior

Email/password via Supabase Auth. New users arrive pre-confirmed with a temporary password (created through `admin-manage`) and are forced to change it on first login. Session: standard Supabase JWT refresh; when a user's role or clinic changes, they must re-login for the new JWT to apply — the UI surfaces this after any role change ("User must sign out and back in"). Deactivation is implemented with Supabase's user ban (`banned_until`), which blocks token refresh.

---

## 4. Data model changes

### 4.1 New: clinics

```
clinics: id, name, phone_callback, timezone (IANA), calling_hours jsonb
         (per-weekday {start,end} local times), sms_fallback boolean,
         greeting_default text, active boolean, created_at
```

`clinic_id uuid not null references clinics(id)` is added to: `patients`, `campaigns`, `providers`, `call_logs`. Existing single-clinic data migrates with a backfill to one seed clinic row.

### 4.2 Patients

Add `do_not_call boolean not null default false` and `active boolean not null default true`. The dialer (`start-campaign`) must exclude `do_not_call` and inactive patients at query level — not just the UI.

### 4.3 Campaigns & campaign_patients

Campaigns: replace `active boolean` with `status text check (draft|scheduled|active|paused|completed)`, add `scheduled_start timestamptz`, `created_by uuid`. campaign_patients: add `resolved` to the status enum, plus `resolved_by uuid` and `resolved_at timestamptz`.

### 4.4 Calling hours enforcement

`start-campaign` checks the clinic's calling hours (clinic-local, using the clinic's timezone) before dialing and exits quietly outside the window. The pg_cron schedule can therefore run every 15 minutes all day without risk of after-hours calls. Suggested default window: 09:00–19:00 local, configurable per clinic. (Regulatory note for the team: outbound calling windows and consent rules — TCPA and state equivalents — are a compliance requirement, not a nice-to-have; the DNC flag and hours gate are the technical halves of that.)

### 4.5 New: audit_log

```
audit_log: id, clinic_id, actor_user_id, action text, target_type text,
           target_id uuid, detail jsonb, created_at
```

Written by `admin-manage` (user events) and by triggers on patients/campaigns/clinics for create/update/delete. Read-only in the UI (Admin sees all; Clinic Admin sees own clinic). This is the minimum trail a HIPAA-conscious customer will ask about.

### 4.6 RLS pattern

Helper functions `is_admin()`, `jwt_clinic_id()`, `is_clinic_admin()`. Policy shape for every clinic-scoped table:

```sql
using ( is_admin() or clinic_id = jwt_clinic_id() )
```

with write policies additionally requiring `is_admin() or is_clinic_admin()` on management tables (clinics, providers, provider_availability, clinic settings) and allowing Staff writes only where the matrix grants them (campaigns, campaign_patients, review resolutions).

---

## 5. Edge function changes

**admin-manage** (extend): actions become `create_user` (role + clinic_id, permission-checked: Clinic Admin may only create Staff in own clinic), `set_role` (Admin only), `reset_password` (sets temporary password + force-change flag), `deactivate_user` / `reactivate_user`, `create_clinic` (Admin only). Every action writes an audit_log row.

**start-campaign** (extend): clinic-hours gate, DNC/inactive-patient exclusion, campaign status must be `active`, respects pause immediately.

**telnyx-call-events / assistant-tools**: read clinic name, callback number, and timezone from the `clinics` row (via the campaign) rather than environment secrets, so multiple clinics work from one deployment. Env values remain as fallback defaults.

---

## 6. Build order (suggested)

**Phase 1 — foundations:** clinics table + clinic_id backfill, role helpers + RLS rewrite, extended admin-manage, login screen + forced password change, audit log. *Nothing user-visible breaks; everything after depends on this.*

**Phase 2 — role dashboards:** three dashboard variants, nav guards, clinic switcher for Admin, review queue page (highest operational value per line of code).

**Phase 3 — management surfaces:** clinicians & availability editor, clinic settings page, user management page, patient detail + DNC.

**Phase 4 — campaign lifecycle:** status machine, scheduling + pg_cron, calling-hours enforcement, campaign detail/debug tab, CSV dry-run preview, avatars.

---

## 7. Decisions & defaults

**Decided by product owner (July 5, 2026):**

* **D1 — Staff campaign creation: NO.** Staff run, schedule, pause, and review campaigns only. Campaign creation and editing is Clinic Admin and above. Enforced in RLS (Staff have no insert/update policy on `campaigns`) and in the UI (no /campaigns/new route, no create buttons).
* **D2 — Multi-clinic: schema yes, UI stubbed.** The `clinics` table, `clinic_id` columns, and clinic-scoped RLS ship in Phase 1. The MVP seeds exactly one clinic; the Admin clinic switcher is a disabled stub behind a feature flag. No table may be created without `clinic_id` even in MVP — retrofitting is the expensive path this decision avoids.

**Defaults (in effect unless product owner overrides — none block development):**

* **D3 — Staff activity visibility:** audit log is sufficient for v1; no per-user activity report.
* **D4 — Password reset:** admin-set temporary password with forced change on first login (no SMTP dependency). Email reset links may be added later once SMTP is configured.
* **D5 — Review queue SLA:** no escalation styling in v1; the unresolved-count badge is sufficient. Revisit after real usage data.
