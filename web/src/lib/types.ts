export type Role = "admin" | "clinic_admin" | "staff";

export type CampaignStatus = "draft" | "scheduled" | "active" | "paused" | "completed";

export type CampaignPatientStatus =
  | "pending" | "calling" | "booked" | "declined" | "callback_requested"
  | "no_answer" | "voicemail" | "wrong_number" | "verification_failed"
  | "needs_human" | "resolved";

export type Clinic = {
  id: string;
  name: string;
  phone_callback: string | null;
  timezone: string;
  calling_hours: Record<string, { start: string; end: string } | null>;
  sms_fallback: boolean;
  greeting_default: string | null;
  active: boolean;
  created_at: string;
};

export type Patient = {
  id: string;
  clinic_id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  date_of_birth: string;
  provider_id: string | null;
  notes: string | null;
  do_not_call: boolean;
  active: boolean;
  created_at: string;
};

export type Provider = {
  id: string;
  clinic_id: string;
  name: string;
  specialty: string | null;
  active: boolean;
  created_at: string;
};

export type Availability = {
  id: string;
  provider_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  slot_length_minutes: number;
};

export type Campaign = {
  id: string;
  clinic_id: string;
  name: string;
  appointment_type: string;
  greeting_context: string;
  provider_id: string | null;
  slot_length_minutes: number;
  status: CampaignStatus;
  scheduled_start: string | null;
  created_by: string | null;
  created_at: string;
};

export type CampaignStat = {
  campaign_id: string;
  clinic_id: string;
  name: string;
  status: CampaignStatus;
  total_patients: number;
  pending: number;
  booked: number;
  declined: number;
  unreached: number;
  needs_human: number;
  booking_rate_pct: number | null;
};

export type ReviewItem = {
  campaign_id: string;
  patient_id: string;
  status: CampaignPatientStatus;
  flag_reason: string | null;
  updated_at: string;
  patients?: { first_name: string; last_name: string };
  campaigns?: { name: string };
};

export type AuditEntry = {
  id: string;
  clinic_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: unknown;
  created_at: string;
};
