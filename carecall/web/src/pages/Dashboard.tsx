import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Stats = {
  campaign_id: string; name: string; total_patients: number; pending: number;
  booked: number; declined: number; unreached: number; needs_human: number;
  booking_rate_pct: number | null;
};
type LiveRow = {
  campaign_id: string; patient_id: string; status: string; updated_at: string;
  patients?: { first_name: string; last_name: string };
};

export default function Dashboard() {
  const [stats, setStats] = useState<Stats[]>([]);
  const [feed, setFeed] = useState<LiveRow[]>([]);
  const [starting, setStarting] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("campaign_stats").select("*");
    setStats((data as Stats[]) ?? []);
    const { data: recent } = await supabase
      .from("campaign_patients")
      .select("campaign_id, patient_id, status, updated_at, patients(first_name, last_name)")
      .neq("status", "pending")
      .order("updated_at", { ascending: false })
      .limit(12);
    setFeed((recent as unknown as LiveRow[]) ?? []);
  }

  useEffect(() => {
    load();
    // Realtime: refresh the feed whenever a campaign_patient changes
    const channel = supabase
      .channel("live-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "campaign_patients" }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  async function startCampaign(id: string) {
    setStarting(id);
    const { data: { session } } = await supabase.auth.getSession();
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/start-campaign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ campaign_id: id, batch_size: 3 }),
    });
    setStarting(null);
    load();
  }

  const totals = stats.reduce(
    (a, s) => ({
      booked: a.booked + Number(s.booked),
      pending: a.pending + Number(s.pending),
      unreached: a.unreached + Number(s.unreached),
      needs_human: a.needs_human + Number(s.needs_human),
    }),
    { booked: 0, pending: 0, unreached: 0, needs_human: 0 },
  );

  return (
    <>
      <h1>Dashboard</h1>
      <div className="cards">
        <div className="card"><div className="num">{totals.booked}</div><div className="lbl">Booked</div></div>
        <div className="card"><div className="num">{totals.pending}</div><div className="lbl">In queue</div></div>
        <div className="card"><div className="num">{totals.unreached}</div><div className="lbl">Unreached</div></div>
        <div className="card"><div className="num">{totals.needs_human}</div><div className="lbl">Needs follow-up</div></div>
      </div>

      <h2>Campaigns</h2>
      <table>
        <thead><tr><th>Campaign</th><th>Booked</th><th>Pending</th><th>Booking rate</th><th></th></tr></thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.campaign_id}>
              <td>{s.name}</td>
              <td>{s.booked} / {s.total_patients}</td>
              <td>{s.pending}</td>
              <td>{s.booking_rate_pct != null ? `${s.booking_rate_pct}%` : "—"}</td>
              <td>
                <button disabled={starting === s.campaign_id || !s.pending}
                        onClick={() => startCampaign(s.campaign_id)}>
                  {starting === s.campaign_id ? "Dialing…" : "Start calling"}
                </button>
              </td>
            </tr>
          ))}
          {!stats.length && <tr><td colSpan={5} className="empty">Create a campaign and add patients to begin.</td></tr>}
        </tbody>
      </table>

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
    </>
  );
}
