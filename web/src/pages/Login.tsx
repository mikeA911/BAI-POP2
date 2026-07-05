import { useState } from "react";
import { supabase } from "../lib/supabase";
import { useSession } from "../lib/session";

export default function Login() {
  const { forcePasswordChange, session, refresh } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // If we're already signed in but must change the password, show that form.
  const mustChange = !!session && forcePasswordChange;

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setErr(error.message);
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (newPassword.length < 10) { setErr("Use at least 10 characters."); return; }
    if (newPassword !== confirm) { setErr("Passwords do not match."); return; }
    setBusy(true);
    // Clear the force-change flag in user_metadata; app_metadata flag remains
    // for auditing but the UI keys off a cleared local flag after re-auth.
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
      data: { force_password_change_done: true },
    });
    if (!error) {
      // The app_metadata force flag is only cleared server-side on next admin
      // action; for the session we mark it done and refresh.
      await supabase.auth.refreshSession();
      await refresh();
    }
    setBusy(false);
    if (error) setErr(error.message);
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand">Care<span>Call</span></div>

        {mustChange ? (
          <>
            <h1>Set a new password</h1>
            <p className="muted">Your account was created with a temporary password. Choose a new one to continue.</p>
            <form onSubmit={changePassword}>
              <label htmlFor="np">New password</label>
              <input id="np" type="password" autoComplete="new-password" value={newPassword}
                     onChange={(e) => setNewPassword(e.target.value)} />
              <label htmlFor="cp">Confirm new password</label>
              <input id="cp" type="password" autoComplete="new-password" value={confirm}
                     onChange={(e) => setConfirm(e.target.value)} />
              {err && <p className="auth-err" role="alert">{err}</p>}
              <button type="submit" disabled={busy} style={{ marginTop: 14, width: "100%" }}>
                {busy ? "Saving…" : "Save password"}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1>Sign in</h1>
            <form onSubmit={signIn}>
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="username" value={email}
                     onChange={(e) => setEmail(e.target.value)} />
              <label htmlFor="pw">Password</label>
              <input id="pw" type="password" autoComplete="current-password" value={password}
                     onChange={(e) => setPassword(e.target.value)} />
              {err && <p className="auth-err" role="alert">{err}</p>}
              <button type="submit" disabled={busy} style={{ marginTop: 14, width: "100%" }}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
