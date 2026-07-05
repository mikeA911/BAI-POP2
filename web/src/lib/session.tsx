import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Role } from "./types";

type SessionState = {
  session: Session | null;
  loading: boolean;
  role: Role | null;
  clinicId: string | null;
  displayName: string;
  avatarUrl: string | null;
  /** True when the account was created/reset with a temporary password. */
  forcePasswordChange: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<SessionState | null>(null);

function readClaims(session: Session | null) {
  const meta = (session?.user?.app_metadata ?? {}) as Record<string, unknown>;
  const um = (session?.user?.user_metadata ?? {}) as Record<string, unknown>;
  return {
    role: (meta.role as Role) ?? null,
    clinicId: (meta.clinic_id as string) ?? null,
    forcePasswordChange: meta.force_password_change === true,
    displayName: (um.display_name as string) ?? session?.user?.email ?? "",
    avatarUrl: (um.avatar_url as string) ?? null,
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const claims = readClaims(session);

  const value: SessionState = {
    session,
    loading,
    ...claims,
    refresh,
    signOut: async () => { await supabase.auth.signOut(); },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used within SessionProvider");
  return v;
}

/** Role rank helper for guards: admin > clinic_admin > staff. */
export function roleAtLeast(role: Role | null, min: Role): boolean {
  const rank: Record<Role, number> = { staff: 1, clinic_admin: 2, admin: 3 };
  if (!role) return false;
  return rank[role] >= rank[min];
}
