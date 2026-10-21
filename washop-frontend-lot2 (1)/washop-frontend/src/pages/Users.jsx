// Utilisateurs : propriétaire uniquement.
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Power, UserPlus } from "lucide-react";
import { api } from "../lib/api";
import { initials } from "../lib/format";
import { ROLE_LABELS } from "../lib/labels";
import { useIsDesktop } from "../lib/useMedia";
import { useAuth } from "../state/auth";
import { errorText, useToast } from "../state/toast";
import { Badge, Button, ConfirmModal, Field, Modal, Spinner } from "../components/ui";
import { PageHeader } from "../components/Layout";

const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

function AddSeller({ open, onClose, onCreated }) {
  const toast = useToast();
  const [f, setF] = useState({ name: "", username: "", password: "" });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  useEffect(() => { if (open) { setF({ name: "", username: "", password: "" }); setErrors({}); } }, [open]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: k === "username" ? e.target.value.toLowerCase() : e.target.value }));

  async function submit(e) {
    e?.preventDefault();
    const errs = {};
    if (!f.name.trim()) errs.name = "Le nom est obligatoire.";
    if (!USERNAME_RE.test(f.username)) errs.username = "3 à 40 caractères : lettres minuscules, chiffres, point, tiret ou souligné.";
    if (f.password.length < 8) errs.password = "8 caractères minimum.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      const u = await api.post("/users", { name: f.name.trim(), username: f.username, password: f.password });
      toast.push(`Caissier créé : ${u.name}`, "success");
      onCreated();
      onClose();
    } catch (err) {
      if (err.code === "USERNAME_TAKEN") setErrors({ username: err.detail });
      else toast.push(errorText(err), "error");
    } finally { setLoading(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Ajouter un caissier" footer={<><Button kind="soft" onClick={onClose}>Annuler</Button><Button icon={UserPlus} loading={loading} onClick={submit}>Créer le compte</Button></>}>
      <form onSubmit={submit} className="stack" noValidate>
        <Field label="Nom" error={errors.name}><input value={f.name} onChange={set("name")} maxLength={120} /></Field>
        <Field label="Identifiant" error={errors.username} hint="Il s'en sert pour se connecter."><input value={f.username} onChange={set("username")} autoCapitalize="none" spellCheck={false} maxLength={40} /></Field>
        <Field label="Mot de passe provisoire" error={errors.password} hint="8 caractères minimum. Donne-le au caissier."><input value={f.password} onChange={set("password")} maxLength={72} /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ResetPassword({ user, onClose }) {
  const toast = useToast();
  const [pw, setPw] = useState("");
  const [loading, setLoading] = useState(false);
  if (!user) return null;
  async function submit() {
    setLoading(true);
    try {
      await api.patch(`/users/${user.id}`, { password: pw });
      toast.push(`Mot de passe réinitialisé pour ${user.name}. Ses sessions ont été fermées.`, "success");
      onClose();
    } catch (e) { toast.push(errorText(e), "error"); } finally { setLoading(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Nouveau mot de passe pour ${user.name}`} footer={<><Button kind="soft" onClick={onClose}>Annuler</Button><Button icon={KeyRound} disabled={pw.length < 8} loading={loading} onClick={submit}>Réinitialiser</Button></>}>
      <Field label="Mot de passe provisoire" hint="8 caractères minimum. Le caissier sera déconnecté de ses appareils."><input value={pw} onChange={(e) => setPw(e.target.value)} maxLength={72} autoFocus /></Field>
    </Modal>
  );
}

export default function Users() {
  const { auth } = useAuth();
  const toast = useToast();
  const desktop = useIsDesktop();
  const [users, setUsers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState(null);
  const [disableFor, setDisableFor] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get("/users").then((r) => setUsers(r.items)).catch((e) => { toast.push(errorText(e), "error"); setUsers([]); }), [toast]);
  useEffect(() => { load(); }, [load]);

  async function setActive(u, active) {
    setBusy(true);
    try {
      await api.patch(`/users/${u.id}`, { is_active: active });
      toast.push(active ? `${u.name} est réactivé.` : `${u.name} est désactivé. Sa session est coupée.`, "success");
      setDisableFor(null);
      load();
    } catch (e) { toast.push(errorText(e), "error"); } finally { setBusy(false); }
  }

  const isMe = (u) => u.id === auth.user.id;
  const connected = (u) => (u.sessions || []).some((s) => s.connected);
  const actions = (u) => (u.role === "owner" || isMe(u) ? null : (
    <div className="row-actions">
      <Button kind="soft" size="sm" icon={KeyRound} onClick={() => setResetFor(u)}>Mot de passe</Button>
      {u.is_active
        ? <Button kind="danger" size="sm" icon={Power} onClick={() => setDisableFor(u)}>Désactiver</Button>
        : <Button kind="soft" size="sm" icon={Power} loading={busy} onClick={() => setActive(u, true)}>Réactiver</Button>}
    </div>
  ));

  return (
    <div className="page">
      <PageHeader title="Utilisateurs" sub={desktop ? "Ton équipe de caisse" : null} actions={<Button icon={UserPlus} onClick={() => setAdding(true)}>{desktop ? "Ajouter un caissier" : "Ajouter"}</Button>} />
      {!users ? <Spinner /> : desktop ? (
        <table className="table">
          <thead><tr><th>Nom</th><th>Identifiant</th><th>Rôle</th><th>Statut</th><th className="r">Actions</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><div className="cell-product"><span className="avatar">{initials(u.name)}</span><strong>{u.name}{isMe(u) && <small className="muted"> (toi)</small>}</strong>{connected(u) && <span className="online" title="Connecté">en ligne</span>}</div></td>
                <td className="mono muted">{u.username || u.email}</td>
                <td>{ROLE_LABELS[u.role]}</td>
                <td><Badge kind={u.is_active ? "actif" : "desactive"} /></td>
                <td className="r">{actions(u)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="rows">
          {users.map((u) => (
            <div key={u.id} className="row row-wrap">
              <span className="avatar">{initials(u.name)}</span>
              <div className="row-main"><strong>{u.name}{isMe(u) && " (toi)"}</strong><span className="mono">{u.username || u.email} · {ROLE_LABELS[u.role]}</span></div>
              <Badge kind={u.is_active ? "actif" : "desactive"} />
              {actions(u)}
            </div>
          ))}
        </div>
      )}
      <AddSeller open={adding} onClose={() => setAdding(false)} onCreated={load} />
      <ResetPassword user={resetFor} onClose={() => setResetFor(null)} />
      <ConfirmModal
        open={Boolean(disableFor)}
        title={`Désactiver ${disableFor?.name} ?`}
        text={`${disableFor && connected(disableFor) ? "Il est connecté en ce moment. " : ""}Sa session sera coupée tout de suite et il ne pourra plus se connecter.`}
        confirmLabel="Désactiver"
        danger
        loading={busy}
        onClose={() => setDisableFor(null)}
        onConfirm={() => setActive(disableFor, false)}
      />
    </div>
  );
}
