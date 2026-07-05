import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useSession } from "../lib/session";
import { useClinic } from "../lib/clinic";
import type { ReviewItem } from "../lib/types";

type Row = ReviewItem & { call_summary?: string | null; call_log_id?: string | null };

export default function Review() {
  const { session } = useSession();
  const { activeClinicId } = useClinic();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    if (!activeClinicId) return;
    const { data: camps } = await supabase.from("campaigns").select("id").eq("clinic_id", activeClinicId);
    const ids = (camps ?? []).map((c: { id: string }) => c.id);
    if (!ids.length) { setRows([]); return; }
    const { data } = await supabase.from("campaign_patients")
      .select("campaign_id, patient_id, status, flag_reason, updated_at, patients(first_name, last_name), campaigns(name)")
      .in("campaign_id", ids)
      .in("status", ["needs_human", "verification_failed"])
      .order("updated_at", { ascending: false });
    setRows((data as unknown as Row[]) ?? []);
  }, [activeClinicId]);

  useEffect(() => {
    load();
    const ch = supabase.channel("review-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "campaign_patients" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const key = (r: Row) => `${r.campaign_id}:${r.patient_id}`;

  async function update(r: Row, patch: Record<string, unknown>, message: string) {
    setBusy(key(r));
    const { error } = await supabase.from("campaign_patients").update(patch)
      .eq("campaign_id", r.campaign_id).eq("patient_id", r.patient_id);
    setBusy(null);
    setMsg(error ? `Failed: ${error.message}` : message);
    load();
  }

  async function resolve(r: Row) {
    await update(r, {
      status: "resolved",
      resolved_by: session?.user?.id ?? null,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, "Marked resolved.");
  }

  async function requeue(r: Row) {
    await update(r, { status: "pending", flag_reason: null, updated_at: new Date().toISOString() }, "Requeued for calling.");
  }

  async function removeFromCampaign(r: Row) {
    setBusy(key(r));
    const { error } = await supabase.from("campaign_patients").delete()
      .eq("campaign_id", r.campaign_id).eq("patient_id", r.patient_id);
    setBusy(null);
    setMsg(error ? `Failed: ${error.message}` : "Removed from campaign.");
    load();
  }

  async function doNotCall(r: Row) {
    setBusy(key(r));
    // Patient-level DNC + remove from active campaigns (§2.4).
    const { error: e1 } = await supabase.from("patients")
      .update({ do_not_call: true }).eq("id", r.patient_id);
    const { data: activeCamps } = await supabase.from("campaigns")
      .select("id").eq("clinic_id", activeClinicId!).in("status", ["draft", "scheduled", "active", "paused"]);
    const activeIds = (activeCamps ?? []).map((c: { id: string }) => c.id);
    let e2 = null;
    if (activeIds.length) {
      const res = await supabase.from("campaign_patients").delete()
        .eq("patient_id", r.patient_id).in("campaign_id", activeIds);
      e2 = res.error;
    }
    setBusy(null);
    setMsg(e1 || e2 ? "Failed to set do-not-call." : "Patient set to do-not-call and removed from active campaigns.");
    load();
  }

  return (
    <>
      <h1>Review queue</h1>
      <p className="muted">Calls flagged for human follow-up. Most recent first.</p>
      {msg && <p role="status">{msg}</p>}

      <table>
        <thead>
          <tr><th>Patient</th><th>Campaign</th><th>Flag</th><th>When</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={key(r)}>
              <td>
                <Link to={`/patients/${r.patient_id}`}>
                  {r.patients ? `${r.patients.first_name} ${r.patients.last_name}` : r.patient_id.slice(0, 8)}
                </Link>
              </td>
              <td>{r.campaigns?.name ?? "—"}</td>
              <td>
                <span className={`badge ${r.status}`}>{r.status.replace(/_/g, " ")}</span>
                {r.flag_reason && <div className="muted small">{r.flag_reason}</div>}
              </td>
              <td>{new Date(r.updated_at).toLocaleString()}</td>
              <td>
                <div className="row-actions">
                  <button disabled={busy === key(r)} onClick={() => resolve(r)}>Resolve</button>
                  <button className="secondary" disabled={busy === key(r)} onClick={() => requeue(r)}>Requeue</button>
                  <button className="secondary" disabled={busy === key(r)} onClick={() => removeFromCampaign(r)}>Remove</button>
                  <button className="danger" disabled={busy === key(r)} onClick={() => doNotCall(r)}>Do not call</button>
                </div>
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={5} className="empty">Nothing needs review. Nice.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
