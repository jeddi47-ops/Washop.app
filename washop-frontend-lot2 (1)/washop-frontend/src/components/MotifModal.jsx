// Fenêtre de motif réutilisable (cahier 4.7) : caissier uniquement, jamais pour le propriétaire.
import { useEffect, useState } from "react";
import { MOTIFS, MOTIF_NOTE_MIN } from "../lib/labels";
import { Button, Modal, cx } from "./ui";

export function isMotifValid(code, note) {
  if (!code) return false;
  if (code === "autre") return (note || "").trim().length >= MOTIF_NOTE_MIN;
  return true;
}

export default function MotifModal({ open, title, subtitle, serverError, onConfirm, onClose, loading }) {
  const [code, setCode] = useState(null);
  const [note, setNote] = useState("");

  useEffect(() => { if (open && !serverError) { setCode(null); setNote(""); } }, [open, serverError]);

  const valid = isMotifValid(code, note);
  const len = note.trim().length;
  const needNote = code === "autre";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={<Button className="btn-block btn-lg" disabled={!valid} loading={loading} onClick={() => onConfirm({ motif_code: code, motif_note: note.trim() || null })}>Confirmer</Button>}
    >
      {subtitle && <div className="motif-sub">{subtitle}</div>}
      {serverError && <div className="alert alert-warn">{serverError}</div>}
      <div className="radio-list" role="radiogroup">
        {MOTIFS.map((m) => (
          <button key={m.code} type="button" role="radio" aria-checked={code === m.code} className={cx("radio", code === m.code && "on")} onClick={() => setCode(m.code)}>
            <i />{m.label}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field-label">Précision {needNote ? "(obligatoire)" : "(facultatif)"}</span>
        <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={cx(needNote && len < MOTIF_NOTE_MIN && "warn")} placeholder={needNote ? "Explique en quelques mots" : ""} />
        {needNote && (
          <span className={cx("field-hint", len < MOTIF_NOTE_MIN && "warn-text")}>
            {len < MOTIF_NOTE_MIN ? `Précise en ${MOTIF_NOTE_MIN} caractères minimum` : "C'est bon"} · {len}/{MOTIF_NOTE_MIN}
          </span>
        )}
      </label>
    </Modal>
  );
}
