import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "./supabase";
import { useSession } from "./session";
import type { Clinic } from "./types";

// The "active clinic context". For Clinic Admin / Staff this is always their
// own clinic. For Admin it is the clinic selected in the switcher (D2: stubbed
// to the single seeded clinic until MULTI_CLINIC_ENABLED).
type ClinicCtx = {
  clinics: Clinic[];            // clinics the user can see
  activeClinicId: string | null;
  activeClinic: Clinic | null;
  setActiveClinicId: (id: string) => void;
  loading: boolean;
};

const Ctx = createContext<ClinicCtx | null>(null);

export function ClinicProvider({ children }: { children: ReactNode }) {
  const { role, clinicId, session } = useSession();
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [activeClinicId, setActive] = useState<string | null>(clinicId);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    supabase.from("clinics").select("*").order("name").then(({ data }) => {
      const list = (data as Clinic[]) ?? [];
      setClinics(list);
      // Non-admins are pinned to their own clinic; Admin defaults to the first.
      if (role === "admin") {
        setActive((cur) => cur ?? list[0]?.id ?? null);
      } else {
        setActive(clinicId);
      }
      setLoading(false);
    });
  }, [session, role, clinicId]);

  const activeClinic = clinics.find((c) => c.id === activeClinicId) ?? null;

  return (
    <Ctx.Provider value={{ clinics, activeClinicId, activeClinic, setActiveClinicId: setActive, loading }}>
      {children}
    </Ctx.Provider>
  );
}

export function useClinic(): ClinicCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useClinic must be used within ClinicProvider");
  return v;
}
