import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useClinic } from "../../lib/clinic";
import type { Clinic } from "../../lib/types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
type Hours = Record<string, { start: string; end: string } | null>;

export default function ClinicSettings() {
  const { activeClinicId } = useClinic();
  const [clinic, setClinic] = useState<Clinic | null>(null);
  const [hours, setHours] = useState<Hours>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!activeClinicId) return;
    supabase.from("clinics").select("*").eq("id", activeClinicId).single().then(({ data }) => {
      const c = data as Clinic;
      setClinic(c);
      setHours((c?.calling_hours as Hours) ?? {});
    });
  }, [activeClinicId]);

  function setDay(weekday: number, open: boolean) {
    setHours((h) => ({ ...h, [weekday]: open ? (h[weekday] ?? { start: "09:00", end: "19:00" }) : null }));
  }
  function setTime(weekday: number, which: "start" | "end", value: string) {
    setHours((h) => ({ ...h, [weekday]: { ...(h[weekday] ?? { start: "09:00", end: "19:00" }), [which]: value } }));
  }

  async function save() {
    if (!clinic) return;
    setSaving(true);
    const { error } = await supabase.from("clinics").update({
      name: clinic.name,
      phone_callback: clinic.phone_callback,
      timezone: clinic.timezone,
      calling_hours: hours,
      sms_fallback: clinic.sms_fallback,
      greeting_default: clinic.greeting_default,
    }).eq("id", clinic.id);
    setSaving(false);
    setMsg(error ? `Failed: ${error.message}` : "Clinic settings saved.");
  }

  if (!clinic) return <p className="empty">Loading…</p>;

  return (
    <>
      <h1>Clinic settings</h1>
      {msg && <p role="status">{msg}</p>}

      <div className="form-card" style={{ maxWidth: 640 }}>
        <label>Display name</label>
        <input value={clinic.name} onChange={(e) => setClinic({ ...clinic, name: e.target.value })} />

        <label>Callback phone number</label>
        <input value={clinic.phone_callback ?? ""} placeholder="+1…"
               onChange={(e) => setClinic({ ...clinic, phone_callback: e.target.value })} />

        <label>Timezone (IANA)</label>
        <input value={clinic.timezone} placeholder="America/Chicago"
               onChange={(e) => setClinic({ ...clinic, timezone: e.target.value })} />

        <label>Default greeting context</label>
        <textarea rows={2} value={clinic.greeting_default ?? ""}
                  onChange={(e) => setClinic({ ...clinic, greeting_default: e.target.value })} />

        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={clinic.sms_fallback}
                 onChange={(e) => setClinic({ ...clinic, sms_fallback: e.target.checked })} />
          Send SMS fallback when a call reaches voicemail
        </label>

        <h2>Calling hours (clinic-local)</h2>
        <p className="muted small">Outbound calls only fire inside these windows. Days left closed are never dialed.</p>
        {DAYS.map((label, weekday) => {
          const day = hours[weekday];
          return (
            <div key={weekday} className="hours-row">
              <label style={{ display: "flex", gap: 8, alignItems: "center", width: 120, margin: 0 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={!!day} onChange={(e) => setDay(weekday, e.target.checked)} />
                {label}
              </label>
              {day ? (
                <>
                  <input type="time" value={day.start} onChange={(e) => setTime(weekday, "start", e.target.value)} />
                  <span>–</span>
                  <input type="time" value={day.end} onChange={(e) => setTime(weekday, "end", e.target.value)} />
                </>
              ) : <span className="muted">closed</span>}
            </div>
          );
        })}

        <div style={{ marginTop: 16 }}>
          <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        </div>
      </div>
    </>
  );
}
