import { useEffect, useState } from "react";
import { fc } from "../lib/format";
import { Button, Field, Modal } from "./ui";
import "../credit.css";

// Limite de dette dépassée : le propriétaire tape son mot de passe sur la caisse pour valider ce crédit.
export default function OwnerAuthModal({ open, info, error, loading, onConfirm, onClose }) {
  const [password, setPassword] = useState("");
  useEffect(() => { if (open) setPassword(""); }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Validation du propriétaire"
      footer={(
        <>
          <Button kind="soft" onClick={onClose}>Annuler</Button>
          <Button loading={loading} disabled={!password} onClick={() => onConfirm(password)}>Valider le crédit</Button>
        </>
      )}
    >
      <div className="credit-form">
        {info && (
          <div className="credit-warn red" role="alert">
            Ce client doit déjà <b>{fc(info.current_debt)}</b>. Avec ce crédit, sa dette serait de <b>{fc(info.new_debt)}</b>,
            et la limite de la boutique est de <b>{fc(info.max_debt)}</b>.
          </div>
        )}
        <Field label="Mot de passe du propriétaire" hint="Il reste dans le journal : qui a validé, pour quel client, quel montant.">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" aria-label="Mot de passe du propriétaire" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter" && password) onConfirm(password); }} />
        </Field>
        {error && <div className="credit-error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}
