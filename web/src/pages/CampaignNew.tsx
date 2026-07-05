import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useSession } from "../lib/session";
import { useClinic } from "../lib/clinic";
import type { Provider } from "../lib/types";

export default function CampaignNew() {
  const { session } = useSession();
  const { activeClinicId } = useClinic();
  const navigate = useNavigate();

  const [providers, setProviders] = useState<Provider[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    name: "", appointment_type: "wellness", greeting_context: "",
    provider_id: "", slot_length_minutes: 30, scheduled_start: "",
  });

  useEffect(() => {
    if (!activeClinicId) return;
    supabase.from("providers").select("*").eq("clinic_id", activeClinicId).eq("active", true)
      .then(({ data }) => setProviders((data as Provider[]) ?? []));
  }, [activeClinicId]);

  async function create(status: "draft" | "scheduled") {
    if (!form.name || !form.greeting_context) { setErr("Name and reason are required."); return; }
    if (status === "scheduled" && !form.scheduled_start) { setErr("Pick a start time to schedule."); return; }
    setSaving(true); setErr("");
    const { data, error } = await supabase.from("campaigns").insert({
      clinic_id: activeClinicId,
      name: form.name,
      appointment_type: form.appointment_type,
      greeting_context: form.greeting_context,
      provider_id: form.provider_id || null,
      slot_length_minutes: form.slot_length_minutes,
      status,
      scheduled_start: status === "scheduled" ? new Date(form.scheduled_start).toISOString() : null,
      created_by: session?.user?.id ?? null,
    }).select("id").single();
    setSaving(false);
    if (error) { setErr(error.message); return; }
    navigate(`/campaigns/${data.id}`);
  }

  return (
    <>
      <h1>New campaign</h1>
      <div className="form-card">
        <label htmlFor="c-name">Name</label>
        <input id="c-name" value={form.name} placeholder="Annual Wellness Visits"
               onChange={(e) => setForm({ ...form, name: e.target.value })} />

        <label htmlFor="c-type">Appointment type</label>
        <select id="c-type" value={form.appointment_type}
                onChange={(e) => setForm({ ...form, appointment_type: e.target.value })}>
          <option value="wellness">Annual wellness visit</option>
          <option value="flu_shot">Flu vaccination</option>
          <option value="follow_up">Follow-up appointment</option>
          <option value="new_patient">New patient consultation</option>
          <option value="screening">Screening reminder</option>
        </select>

        <label htmlFor="c-provider">Clinician (blank = patient's own)</label>
        <select id="c-provider" value={form.provider_id}
                onChange={(e) => setForm({ ...form, provider_id: e.target.value })}>
          <option value="">Patient's own clinician</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <label htmlFor="c-slot">Slot length (minutes)</label>
        <input id="c-slot" type="number" min={10} step={5} value={form.slot_length_minutes}
               onChange={(e) => setForm({ ...form, slot_length_minutes: Number(e.target.value) })} />

        <label htmlFor="c-context">Reason the AI gives the patient</label>
        <textarea id="c-context" rows={3} value={form.greeting_context}
                  placeholder="Dr. Jones would like to schedule your annual wellness visit."
                  onChange={(e) => setForm({ ...form, greeting_context: e.target.value })} />

        <label htmlFor="c-sched">Schedule start (optional)</label>
        <input id="c-sched" type="datetime-local" value={form.scheduled_start}
               onChange={(e) => setForm({ ...form, scheduled_start: e.target.value })} />

        {err && <p className="auth-err" role="alert">{err}</p>}

        <div className="row-actions" style={{ marginTop: 14 }}>
          <button disabled={saving} onClick={() => create("draft")}>
            {saving ? "Saving…" : "Save as draft"}
          </button>
          <button className="secondary" disabled={saving} onClick={() => create("scheduled")}>
            Schedule
          </button>
        </div>
      </div>
    </>
  );
}
