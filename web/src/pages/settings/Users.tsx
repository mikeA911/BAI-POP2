import { useCallback, useEffect, useState } from "react";
import { callFunction } from "../../lib/api";
import { useSession, roleLabel } from "../../lib/session";

type PortalUser = {
  id: string; email: string; role: string; clinic_id: string | null;
  deactivated: boolean; last_sign_in_at: string | null; created_at: string;
};

export default function Users() {
  const { role } = useSession();
  const isAdmin = role === "admin";
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState<"staff" | "clinic_admin">("staff");
  const [msg, setMsg] = useState("");
  const [tempPw, setTempPw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await callFunction<{ users: PortalUser[] }>("admin-manage", { action: "list_users" });
    if (error) setMsg(error); else setUsers(data?.users ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function invite() {
    if (!email) return;
    setBusy(true); setTempPw(null);
    const { data, error } = await callFunction<{ temporary_password: string }>("admin-manage", {
      action: "create_user", email, role: isAdmin ? newRole : "staff",
    });
    setBusy(false);
    if (error) { setMsg(error); return; }
    setMsg(`Created ${email}. Share the temporary password below; they'll be forced to change it on first login.`);
    setTempPw(data?.temporary_password ?? null);
    setEmail("");
    load();
  }

  async function resetPassword(u: PortalUser) {
    setBusy(true); setTempPw(null);
    const { data, error } = await callFunction<{ temporary_password: string }>("admin-manage", { action: "reset_password", user_id: u.id });
    setBusy(false);
    if (error) { setMsg(error); return; }
    setMsg(`Password reset for ${u.email}. Share the temporary password below.`);
    setTempPw(data?.temporary_password ?? null);
  }

  async function toggleActive(u: PortalUser) {
    setBusy(true);
    const { error } = await callFunction("admin-manage", { action: u.deactivated ? "reactivate_user" : "deactivate_user", user_id: u.id });
    setBusy(false);
    setMsg(error ?? (u.deactivated ? "User reactivated." : "User deactivated."));
    load();
  }

  async function changeRole(u: PortalUser, role: string) {
    if (role === u.role) return;
    setBusy(true); setTempPw(null);
    const { data, error } = await callFunction<{ note?: string }>("admin-manage", {
      action: "set_role", user_id: u.id, role, clinic_id: u.clinic_id,
    });
    setBusy(false);
    if (error) { setMsg(error); return; }
    setMsg(`Role for ${u.email} changed to ${roleLabel(role)}. ${data?.note ?? ""}`.trim());
    load();
  }

  return (
    <>
      <h1>Users</h1>
      {msg && <p role="status">{msg}</p>}
      {tempPw && (
        <div className="temp-pw">
          Temporary password: <code>{tempPw}</code>
        </div>
      )}

      <div className="form-card" style={{ maxWidth: 560 }}>
        <label>Invite user</label>
        <input type="email" placeholder="name@clinic.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        {isAdmin && (
          <>
            <label>Role</label>
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as "staff" | "clinic_admin")}>
              <option value="staff">Staff</option>
              <option value="clinic_admin">Provider</option>
            </select>
          </>
        )}
        {!isAdmin && <p className="muted small">Providers can invite Staff only. Creating Providers is Admin-only.</p>}
        <div style={{ marginTop: 10 }}>
          <button onClick={invite} disabled={busy || !email}>Invite</button>
        </div>
      </div>

      <h2>Clinic users</h2>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Actions</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.deactivated ? "row-muted" : ""}>
              <td>{u.email}</td>
              <td>
                {isAdmin ? (
                  <select value={u.role} disabled={busy} onChange={(e) => changeRole(u, e.target.value)}>
                    <option value="staff">Staff</option>
                    <option value="clinic_admin">Provider</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  roleLabel(u.role)
                )}
              </td>
              <td>{u.deactivated ? <span className="badge declined">deactivated</span> : <span className="badge booked">active</span>}</td>
              <td>{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "never"}</td>
              <td>
                <div className="row-actions">
                  <button className="secondary" disabled={busy} onClick={() => resetPassword(u)}>Reset password</button>
                  <button className={u.deactivated ? "secondary" : "danger"} disabled={busy} onClick={() => toggleActive(u)}>
                    {u.deactivated ? "Reactivate" : "Deactivate"}
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {!users.length && <tr><td colSpan={5} className="empty">No users found.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
