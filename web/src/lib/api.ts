import { supabase } from "./supabase";
import { FUNCTIONS_URL } from "./config";

/** Call a Supabase edge function with the current user's bearer token. */
export async function callFunction<T = unknown>(
  name: string,
  body: unknown,
): Promise<{ data: T | null; error: string | null }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { data: null, error: "Not signed in." };
  try {
    const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { data: null, error: json.error ?? `Request failed (${res.status})` };
    return { data: json as T, error: null };
  } catch (e) {
    return { data: null, error: (e as Error).message };
  }
}
