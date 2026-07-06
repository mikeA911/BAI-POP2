// Public booking API client for the /book/:token page.
//
// Unlike lib/api.ts (which attaches the signed-in staff user's JWT), the booking
// page has NO authenticated user: the patient is not a portal account. The
// booking-api edge function runs with verify_jwt OFF, but the Supabase gateway
// still requires the project's anon/publishable key as the apikey header, so we
// send that. No PHI is ever placed in the URL — only the opaque token in the
// request body.
import { FUNCTIONS_URL } from "./config";

const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export type BookingState =
  | "needs_verification"
  | "ready"
  | "booked"
  | "expired"
  | "locked";

export type ContextResp = {
  clinic_name: string;
  appointment_type_label: string;
  timezone: string;
  state: BookingState;
};

export type VerifyResp = {
  verified: boolean;
  first_name?: string;
  state?: BookingState;
  remaining_attempts?: number;
  error?: string;
};

export type DayOption = { date: string; label: string; count: number };
export type TimeOption = { slot_start: string; slot_end: string; label: string };

export type SlotsResp = {
  days?: DayOption[];
  times?: TimeOption[];
  timezone?: string;
  state?: BookingState;
};

export type BookResp = {
  booked?: boolean;
  already?: boolean;
  reason?: string;
  appointment_id?: string | null;
  spoken?: string | null;
  state?: BookingState;
  error?: string;
};

async function post<T>(action: string, body: Record<string, unknown>): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(`${FUNCTIONS_URL}/booking-api?action=${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { data: json as T, error: (json as { error?: string }).error ?? `Request failed (${res.status})` };
    return { data: json as T, error: null };
  } catch (e) {
    return { data: null, error: (e as Error).message };
  }
}

export const bookingApi = {
  context: (token: string) => post<ContextResp>("context", { token }),
  verify: (token: string, statedDob: string) =>
    post<VerifyResp>("verify", { token, stated_date_of_birth: statedDob }),
  days: (token: string) => post<SlotsResp>("slots", { token, granularity: "days" }),
  times: (token: string, onDate: string) =>
    post<SlotsResp>("slots", { token, granularity: "times", on_date: onDate }),
  book: (token: string, slotStart: string) => post<BookResp>("book", { token, slot_start: slotStart }),
  decline: (token: string) => post<{ declined?: boolean }>("decline", { token, callback: true }),
};
