import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { callFunction } from "../lib/api";
import { useSession, roleAtLeast } from "../lib/session";
import { useClinic } from "../lib/clinic";
import type { Campaign, CampaignStatus } from "../lib/types";

const STATUSES: (CampaignStatus | "all")[] = ["all", "draft", "scheduled", "active", "paused", "completed"];

export default function Campaigns() {
  const { role } = useSession();
  const { activeClinicId } = useClinic();
  const navigate = useNavigate();
  const canManage = roleAtLeast(role, "clinic_admin");

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [filter, setFilter] = useState<CampaignStatus | "all">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    if (!activeClinicId) return;
    const { data } = await supabase.from("campaigns")
      .select("*").eq("clinic_id", activeClinicId).order("created_at", { ascending: false });
    setCampaigns((data as Campaign[]) ?? []);
  }, [activeClinicId]);

  useEffect(() => { load(); }, [load]);

  async function setStatus(c: Campaign, status: CampaignStatus) {
    setBusy(c.id);
    const { error } = await supabase.from("campaigns").update({ status }).eq("id", c.id);
    setBusy(null);
    setMsg(error ? `Failed: ${error.message}` : `Campaign ${status}.`);
    load();
  }

  async function startCalling(c: Campaign) {
    setBusy(c.id);
    // Move to active first (Staff may run/schedule/pause — RLS allows the update).
    if (c.status !== "active") await supabase.from("campaigns").update({ status: "active" }).eq("id", c.id);
    const { error } = await callFunction("start-campaign", { campaign_id: c.id, batch_size: 3 });
    setBusy(null);
    setMsg(error ? `Dialer: ${error}` : "Dialing started.");
    load();
  }

  const shown = campaigns.filter((c) => filter === "all" || c.status === filter);

  return (
    <>
      <div className="page-head">
        <h1>Campaigns</h1>
        {canManage && <button onClick={() => navigate("/campaigns/new")}>New campaign</button>}
      </div>
      {msg && <p role="status">{msg}</p>}

      <div className="filter-row">
        {STATUSES.map((s) => (
          <button key={s} className={`chip ${filter === s ? "chip-on" : ""}`} onClick={() => setFilter(s)}>{s}</button>
        ))}
      </div>

      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.id}>
              <td><Link to={`/campaigns/${c.id}`}>{c.name}</Link></td>
              <td>{c.appointment_type}</td>
              <td><span className={`badge status-${c.status}`}>{c.status}</span></td>
              <td>
                <div className="row-actions">
                  {(c.status === "draft" || c.status === "scheduled" || c.status === "paused") && (
                    <button disabled={busy === c.id} onClick={() => startCalling(c)}>
                      {busy === c.id ? "Starting…" : "Start calling"}
                    </button>
                  )}
                  {c.status === "active" && (
                    <button className="secondary" disabled={busy === c.id} onClick={() => setStatus(c, "paused")}>Pause</button>
                  )}
                  <Link className="btn secondary" to={`/campaigns/${c.id}`}>Open</Link>
                </div>
              </td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={4} className="empty">No campaigns in this view.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
