// Feature flags (D2: multi-clinic schema ships, UI switcher stubbed).
// Flip VITE_MULTI_CLINIC=true once more than one clinic is seeded.
export const MULTI_CLINIC_ENABLED =
  String(import.meta.env.VITE_MULTI_CLINIC ?? "").toLowerCase() === "true";

export const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
