import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useSession } from "../../lib/session";

export default function Profile() {
  const { session, displayName, avatarUrl, refresh } = useSession();
  const [name, setName] = useState(displayName);
  const [avatar, setAvatar] = useState<string | null>(avatarUrl);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setName(displayName); setAvatar(avatarUrl); }, [displayName, avatarUrl]);

  async function saveProfile() {
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ data: { display_name: name, avatar_url: avatar } });
    setBusy(false);
    setMsg(error ? `Failed: ${error.message}` : "Profile saved.");
    await refresh();
  }

  async function onAvatar(file: File) {
    if (file.size > 1024 * 1024) { setMsg("Image must be 1 MB or smaller."); return; }
    setBusy(true);
    try {
      const square = await cropSquare(file);
      const path = `${session?.user?.id}/avatar.png`;
      const { error } = await supabase.storage.from("avatars").upload(path, square, { upsert: true, contentType: "image/png" });
      if (error) throw error;
      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      const url = `${data.publicUrl}?t=${Date.now()}`;
      setAvatar(url);
      await supabase.auth.updateUser({ data: { display_name: name, avatar_url: url } });
      await refresh();
      setMsg("Avatar updated.");
    } catch (e) {
      setMsg(`Upload failed: ${(e as Error).message}`);
    }
    setBusy(false);
  }

  async function changePassword() {
    if (password.length < 10) { setMsg("Use at least 10 characters."); return; }
    if (password !== confirm) { setMsg("Passwords do not match."); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    setMsg(error ? `Failed: ${error.message}` : "Password changed.");
    setPassword(""); setConfirm("");
  }

  return (
    <>
      <h1>My profile</h1>
      {msg && <p role="status">{msg}</p>}

      <div className="form-card" style={{ maxWidth: 480 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <div className="avatar-lg">
            {avatar ? <img src={avatar} alt="avatar" /> : <span>{(name || "?").slice(0, 1).toUpperCase()}</span>}
          </div>
          <div>
            <button className="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>Change avatar</button>
            <input ref={fileRef} type="file" accept="image/*" hidden
                   onChange={(e) => e.target.files?.[0] && onAvatar(e.target.files[0])} />
            <div className="muted small">Square image, 1 MB max.</div>
          </div>
        </div>

        <label style={{ marginTop: 16 }}>Display name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <label>Email</label>
        <input value={session?.user?.email ?? ""} disabled />
        <div style={{ marginTop: 12 }}><button onClick={saveProfile} disabled={busy}>Save profile</button></div>
      </div>

      <h2>Change password</h2>
      <div className="form-card" style={{ maxWidth: 480 }}>
        <label>New password</label>
        <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label>Confirm new password</label>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <div style={{ marginTop: 12 }}><button onClick={changePassword} disabled={busy}>Change password</button></div>
      </div>
    </>
  );
}

/** Crop to a centered square and downscale to 256px PNG, client-side (§2.8). */
function cropSquare(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = Math.min(img.width, img.height);
      const canvas = document.createElement("canvas");
      canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no canvas context"));
      ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, 256, 256);
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error("crop failed")), "image/png");
    };
    img.onerror = () => reject(new Error("could not read image"));
    img.src = URL.createObjectURL(file);
  });
}
