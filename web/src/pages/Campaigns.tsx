import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Provider = { id: string; name: string };
type Campaign = {
  id: string; name: string; appointment_type: string;
  greeting_context: string; active: boolean; provider_id: string | null;
};

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [form, setForm] = useState({ name: "", appointment_type: "wellness", greeting_context: "", provider_id: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    const [{ data: c }, { data: p }] = await Promise.all([
      supabase.from("campaigns").select("*").order("created_at", { ascending: false }),
      supabase.from("providers").select("id, name").eq("active", true),
    ]);
    setCampaigns((c as Campaign[]) ?? []);
    setProviders((p as Provider[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  async function create() {
    if (!form.name || !form.greeting_context) return;
    setSaving(true);
    await supabase.from("campaigns").insert({
      name: form.name,
      appointment_type: form.appointment_type,
      greeting_context: form.greeting_context,
      provider_id: form.provider_id || null,
    });
    setForm({ name: "", appointment_type: "wellness", greeting_context: "", provider_id: "" });
    setSaving(false);
    load();
  }

  return (
    <>
      <h1>Campaigns</h1>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Reason given to patients</th><th>Status</th></tr></thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.appointment_type}</td>
              <td>{c.greeting_context}</td>
              <td><span className={`badge ${c.active ? "booked" : "declined"}`}>{c.active ? "active" : "paused"}</span></td>
            </tr>
          ))}
          {!campaigns.length && <tr><td colSpan={4} className="empty">No campaigns yet.</td></tr>}
        </tbody>
      </table>

      <h2>New campaign</h2>
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

        <label htmlFor="c-provider">Provider (blank = patient's own provider)</label>
        <select id="c-provider" value={form.provider_id}
                onChange={(e) => setForm({ ...form, provider_id: e.target.value })}>
          <option value="">Patient's own provider</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <label htmlFor="c-context">Reason the AI gives the patient</label>
        <textarea id="c-context" rows={3} value={form.greeting_context}
                  placeholder="Dr. Jones would like to schedule your annual wellness visit."
                  onChange={(e) => setForm({ ...form, greeting_context: e.target.value })} />

        <div style={{ marginTop: 14 }}>
          <button onClick={create} disabled={saving || !form.name || !form.greeting_context}>
            {saving ? "Creating…" : "Create campaign"}
          </button>
        </div>
      </div>
    </>
  );
}
