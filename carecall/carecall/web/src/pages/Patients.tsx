import { useEffect, useState } from "react";
import Papa from "papaparse";
import { supabase } from "../lib/supabase";

type Patient = { id: string; first_name: string; last_name: string; phone: string; date_of_birth: string };
type Campaign = { id: string; name: string };

// Expected CSV headers: first_name,last_name,phone,date_of_birth[,email,notes]
export default function Patients() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [targetCampaign, setTargetCampaign] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({ first_name: "", last_name: "", phone: "", date_of_birth: "" });

  async function load() {
    const [{ data: p }, { data: c }] = await Promise.all([
      supabase.from("patients").select("id, first_name, last_name, phone, date_of_birth").order("created_at", { ascending: false }).limit(200),
      supabase.from("campaigns").select("id, name").eq("active", true),
    ]);
    setPatients((p as Patient[]) ?? []);
    setCampaigns((c as Campaign[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  function onCsv(file: File) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (res) => {
        const rows = (res.data as Record<string, string>[])
          .filter((r) => r.first_name && r.phone && r.date_of_birth)
          .map((r) => ({
            first_name: r.first_name.trim(),
            last_name: (r.last_name ?? "").trim(),
            phone: normalizePhone(r.phone),
            date_of_birth: r.date_of_birth.trim(),
            email: r.email?.trim() || null,
            notes: r.notes?.trim() || null,
          }));
        if (!rows.length) { setMsg("No valid rows found. Headers needed: first_name, last_name, phone, date_of_birth"); return; }
        const { error } = await supabase.from("patients")
          .upsert(rows, { onConflict: "phone,date_of_birth", ignoreDuplicates: true });
        setMsg(error ? `Import failed: ${error.message}` : `Imported ${rows.length} patients.`);
        load();
      },
    });
  }

  async function addOne() {
    const { error } = await supabase.from("patients").insert({ ...form, phone: normalizePhone(form.phone) });
    setMsg(error ? `Failed: ${error.message}` : "Patient added.");
    setForm({ first_name: "", last_name: "", phone: "", date_of_birth: "" });
    load();
  }

  async function assign() {
    if (!targetCampaign || !selected.size) return;
    const rows = [...selected].map((patient_id) => ({ campaign_id: targetCampaign, patient_id }));
    const { error } = await supabase.from("campaign_patients")
      .upsert(rows, { onConflict: "campaign_id,patient_id", ignoreDuplicates: true });
    setMsg(error ? `Failed: ${error.message}` : `Added ${rows.length} patients to the campaign queue.`);
    setSelected(new Set());
  }

  function toggle(id: string) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  return (
    <>
      <h1>Patients</h1>
      {msg && <p role="status">{msg}</p>}

      <div className="form-card">
        <label htmlFor="csv">Import CSV (first_name, last_name, phone, date_of_birth)</label>
        <input id="csv" type="file" accept=".csv"
               onChange={(e) => e.target.files?.[0] && onCsv(e.target.files[0])} />

        <label>Or add one patient</label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input placeholder="First name" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          <input placeholder="Last name" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          <input placeholder="Phone (+1…)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input placeholder="DOB YYYY-MM-DD" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} />
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="secondary" onClick={addOne}
                  disabled={!form.first_name || !form.phone || !form.date_of_birth}>Add patient</button>
        </div>
      </div>

      <h2>Assign to campaign</h2>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, maxWidth: 520 }}>
        <select value={targetCampaign} onChange={(e) => setTargetCampaign(e.target.value)}>
          <option value="">Choose campaign…</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={assign} disabled={!targetCampaign || !selected.size}>
          Add {selected.size || ""} to queue
        </button>
      </div>

      <table>
        <thead><tr><th></th><th>Name</th><th>Phone</th><th>Date of birth</th></tr></thead>
        <tbody>
          {patients.map((p) => (
            <tr key={p.id}>
              <td><input type="checkbox" style={{ width: "auto" }} checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.first_name} ${p.last_name}`} /></td>
              <td>{p.first_name} {p.last_name}</td>
              <td>{p.phone}</td>
              <td>{p.date_of_birth}</td>
            </tr>
          ))}
          {!patients.length && <tr><td colSpan={4} className="empty">Import a CSV or add a patient to get started.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

function normalizePhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return raw.startsWith("+") ? raw : `+${d}`;
}
