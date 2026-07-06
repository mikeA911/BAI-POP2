import { useState } from "react";
import { supabase } from "../lib/supabase";
import { useSession } from "../lib/session";
import About from "./About";

export default function Login() {
  const { forcePasswordChange, passwordRecovery, clearPasswordRecovery, session, refresh } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"signin" | "forgot" | "about">("signin");
  const [sent, setSent] = useState(false);

  // If we're already signed in but must change the password, show that form.
  // This covers both admin-issued temporary passwords and "forgot password" recovery links.
  const mustChange = !!session && (forcePasswordChange || passwordRecovery);

  function goForgot() {
    setErr(""); setSent(false); setMode("forgot");
  }

  function goSignIn() {
    setErr(""); setSent(false); setMode("signin");
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setErr(error.message);
  }

  async function sendReset(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (!email) { setErr("Enter your email address."); return; }
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/`,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setSent(true);
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
      clearPasswordRecovery();
      await supabase.auth.refreshSession();
      await refresh();
    }
    setBusy(false);
    if (error) setErr(error.message);
  }

  // The About panel is wider than the auth card and manages its own header.
  if (!mustChange && mode === "about") {
    return (
      <div className="auth-screen">
        <div className="auth-card about-card">
          <div className="brand">Care<span>Call</span></div>
          <About onClose={goSignIn} />
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand">Care<span>Call</span></div>

        {mustChange ? (
          <>
            <h1>Set a new password</h1>
            <p className="muted">
              {passwordRecovery
                ? "Choose a new password to finish resetting your account."
                : "Your account was created with a temporary password. Choose a new one to continue."}
            </p>
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
        ) : mode === "forgot" ? (
          <>
            <h1>Reset password</h1>
            {sent ? (
              <>
                <p className="muted">If an account exists for <strong>{email}</strong>, a password reset link is on its way. Check your inbox and follow the link to set a new password.</p>
                <button type="button" className="link" onClick={goSignIn} style={{ marginTop: 14 }}>
                  Back to sign in
                </button>
              </>
            ) : (
              <>
                <p className="muted">Enter your account email and we'll send you a link to reset your password.</p>
                <form onSubmit={sendReset}>
                  <label htmlFor="rEmail">Email</label>
                  <input id="rEmail" type="email" autoComplete="username" value={email}
                         onChange={(e) => setEmail(e.target.value)} />
                  {err && <p className="auth-err" role="alert">{err}</p>}
                  <button type="submit" disabled={busy} style={{ marginTop: 14, width: "100%" }}>
                    {busy ? "Sending…" : "Send reset link"}
                  </button>
                </form>
                <button type="button" className="link" onClick={goSignIn} style={{ marginTop: 12 }}>
                  Back to sign in
                </button>
              </>
            )}
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
            <div className="auth-links">
              <button type="button" className="link" onClick={goForgot}>
                Forgot password?
              </button>
              <button type="button" className="link" onClick={() => { setErr(""); setMode("about"); }}>
                About CareCall
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
