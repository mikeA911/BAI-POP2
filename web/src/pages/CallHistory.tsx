import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useClinic } from "../lib/clinic";

type Log = {
  id: string; started_at: string; duration_seconds: number | null;
  amd_result: string | null; verified: boolean; result: string | null;
  summary: string | null; transcript: unknown;
  patients?: { first_name: string; last_name: string };
  campaigns?: { name: string };
};

export default function CallHistory() {
  const { activeClinicId } = useClinic();
  const [logs, setLogs] = useState<Log[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!activeClinicId) return;
    supabase.from("call_logs")
      .select("*, patients(first_name, last_name), campaigns(name)")
      .eq("clinic_id", activeClinicId)
      .order("started_at", { ascending: false })
      .limit(100)
      .then(({ data }) => setLogs((data as unknown as Log[]) ?? []));
  }, [activeClinicId]);

  return (
    <>
      <h1>Call history</h1>
      <table>
        <thead>
          <tr><th>When</th><th>Patient</th><th>Campaign</th><th>Answered by</th><th>Verified</th><th>Result</th><th>Length</th></tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id} onClick={() => setOpen(open === l.id ? null : l.id)} style={{ cursor: "pointer" }}>
              <td>{new Date(l.started_at).toLocaleString()}</td>
              <td>{l.patients ? `${l.patients.first_name} ${l.patients.last_name}` : "—"}</td>
              <td>{l.campaigns?.name ?? "—"}</td>
              <td>{l.amd_result ?? "—"}</td>
              <td>{l.verified ? "yes" : "no"}</td>
              <td>{l.result ? <span className={`badge ${l.result}`}>{l.result.replace(/_/g, " ")}</span> : "—"}</td>
              <td>{l.duration_seconds != null ? `${l.duration_seconds}s` : "—"}</td>
            </tr>
          ))}
          {!logs.length && <tr><td colSpan={7} className="empty">No calls yet.</td></tr>}
        </tbody>
      </table>

      {open && (() => {
        const l = logs.find((x) => x.id === open);
        if (!l) return null;
        return (
          <div className="form-card" style={{ marginTop: 16, maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>Call detail</h2>
            {l.summary && <p><strong>AI summary:</strong> {l.summary}</p>}
            <p><strong>Transcript</strong></p>
            <pre className="transcript-box">
              {l.transcript ? JSON.stringify(l.transcript, null, 2) : "Transcript not captured for this call."}
            </pre>
          </div>
        );
      })()}
    </>
  );
}
