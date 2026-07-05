import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useSession, roleAtLeast } from "../lib/session";
import { useClinic } from "../lib/clinic";
import type { AuditEntry } from "../lib/types";

type LiveRow = {
  campaign_id: string; patient_id: string; status: string; updated_at: string;
  patients?: { first_name: string; last_name: string };
};

export default function Dashboard() {
  const { role } = useSession();
  const { activeClinic, activeClinicId, clinics } = useClinic();
  const navigate = useNavigate();
  const isAdmin = role === "admin";
  const isClinicAdmin = roleAtLeast(role, "clinic_admin");

  const [feed, setFeed] = useState<LiveRow[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [cards, setCards] = useState({
    clinics: 0, patientsOnFile: 0, inCampaign: 0, needsReview: 0,
  });

  async function load() {
    if (!activeClinicId) return;

    // Patients on file (active clinic; Admin cards also show all-clinic totals).
    const patientsQuery = isAdmin
      ? supabase.from("patients").select("id", { count: "exact", head: true })
      : supabase.from("patients").select("id", { count: "exact", head: true }).eq("clinic_id", activeClinicId);
    const { count: patientsOnFile } = await patientsQuery;

    // Campaigns in the active clinic → their patients.
    const { data: camps } = await supabase.from("campaigns").select("id").eq("clinic_id", activeClinicId);
    const campIds = (camps ?? []).map((c: { id: string }) => c.id);

    let inCampaign = 0, needsReview = 0;
    if (campIds.length) {
      const inCampQuery = isAdmin
        ? supabase.from("campaign_patients").select("patient_id", { count: "exact", head: true })
        : supabase.from("campaign_patients").select("patient_id", { count: "exact", head: true }).in("campaign_id", campIds);
      const { count: ic } = await inCampQuery;
      inCampaign = ic ?? 0;

      const reviewQuery = isAdmin
        ? supabase.from("campaign_patients").select("patient_id", { count: "exact", head: true }).in("status", ["needs_human", "verification_failed"])
        : supabase.from("campaign_patients").select("patient_id", { count: "exact", head: true }).in("campaign_id", campIds).in("status", ["needs_human", "verification_failed"]);
      const { count: nr } = await reviewQuery;
      needsReview = nr ?? 0;

      const { data: recent } = await supabase.from("campaign_patients")
        .select("campaign_id, patient_id, status, updated_at, patients(first_name, last_name)")
        .in("campaign_id", campIds)
        .neq("status", "pending")
        .order("updated_at", { ascending: false })
        .limit(12);
      setFeed((recent as unknown as LiveRow[]) ?? []);
    } else {
      setFeed([]);
    }

    setCards({ clinics: clinics.length, patientsOnFile: patientsOnFile ?? 0, inCampaign, needsReview });

    if (isClinicAdmin) {
      const auditQuery = isAdmin
        ? supabase.from("audit_log").select("*").order("created_at", { ascending: false }).limit(10)
        : supabase.from("audit_log").select("*").eq("clinic_id", activeClinicId).order("created_at", { ascending: false }).limit(10);
      const { data: a } = await auditQuery;
      setAudit((a as AuditEntry[]) ?? []);
    }
  }

  useEffect(() => {
    load();
    const ch = supabase.channel("dash-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "campaign_patients" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClinicId, role]);

  const headline = isAdmin ? "Platform overview" : activeClinic?.name ?? "Dashboard";

  return (
    <>
      <h1>{headline}</h1>

      <div className="cards">
        {isAdmin && (
          <div className="card"><div className="num">{cards.clinics}</div><div className="lbl">Clinics</div></div>
        )}
        <div className="card"><div className="num">{cards.patientsOnFile}</div><div className="lbl">Patients on file</div></div>
        <div className="card"><div className="num">{cards.inCampaign}</div><div className="lbl">In active campaigns</div></div>
        <Link to="/review" className="card card-link">
          <div className="num">{cards.needsReview}</div><div className="lbl">Calls needing review</div>
        </Link>
      </div>

      {isClinicAdmin && (
        <>
          <h2>Quick actions</h2>
          <div className="quick-actions">
            <button onClick={() => navigate("/patients")}>Add patients</button>
            <button onClick={() => navigate("/campaigns/new")}>Create campaign</button>
            <button className="secondary" onClick={() => navigate("/clinicians")}>Manage clinicians</button>
            <button className="secondary" onClick={() => navigate("/settings/users")}>Invite Staff</button>
            <button className="secondary" onClick={() => navigate("/settings/clinic")}>Clinic settings</button>
          </div>
        </>
      )}

      {!isClinicAdmin && (
        <>
          <h2>Quick actions</h2>
          <div className="quick-actions">
            <button onClick={() => navigate("/campaigns")}>Run / pause campaigns</button>
            <button className="secondary" onClick={() => navigate("/review")}>Work the review queue</button>
          </div>
        </>
      )}

      <h2><span className="live-dot" aria-hidden />Live activity</h2>
      <table>
        <thead><tr><th>Patient</th><th>Status</th><th>Updated</th></tr></thead>
        <tbody>
          {feed.map((r) => (
            <tr key={`${r.campaign_id}-${r.patient_id}`}>
              <td>{r.patients ? `${r.patients.first_name} ${r.patients.last_name}` : r.patient_id.slice(0, 8)}</td>
              <td><span className={`badge ${r.status}`}>{r.status.replace(/_/g, " ")}</span></td>
              <td>{new Date(r.updated_at).toLocaleTimeString()}</td>
            </tr>
          ))}
          {!feed.length && <tr><td colSpan={3} className="empty">No call activity yet.</td></tr>}
        </tbody>
      </table>

      {isClinicAdmin && (
        <>
          <h2>Recent management activity</h2>
          <table>
            <thead><tr><th>Action</th><th>Target</th><th>When</th></tr></thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td>{a.action.replace(/_/g, " ")}</td>
                  <td>{a.target_type ?? "—"}</td>
                  <td>{new Date(a.created_at).toLocaleString()}</td>
                </tr>
              ))}
              {!audit.length && <tr><td colSpan={3} className="empty">No recent activity.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
