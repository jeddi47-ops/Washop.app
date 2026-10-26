import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { fc, parseNumber } from "../lib/format";
import { creditSettings, previewCredit } from "../lib/credit";
import { useAuth } from "../state/auth";
import { Button, Field, Modal } from "./ui";
import CreditPreview, { CreditTotals } from "./CreditPreview";
import CreditTermsFields from "./CreditTermsFields";
import "../credit.css";

export const EMPTY_CREDIT = {
  name: "", idNumber: "", phone: "",
  terms: { down: "", frequency: "weekly", by: "amount", installment: "", count: "" },
};

const digits = (s) => String(s || "").replace(/\D/g, "");
const idKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Inputs de previewCredit à partir de ce que le caissier a saisi.
export const termsInputs = (t) => ({
  down: parseNumber(t.down), frequency: t.frequency, by: t.by,
  installment: parseNumber(t.installment), count: parseNumber(t.count),
});

// Le caissier peut-il valider ? Renvoie un message si quelque chose manque, sinon null.
export function creditProblem(form, preview) {
  if (!form || form.name.trim().length < 2) return "Indique le nom du client.";
  if (idKey(form.idNumber).length < 3) return "Indique le numéro de pièce d'identité.";
  if (digits(form.phone).length < 6) return "Indique le téléphone du client.";
  if (preview.error) return preview.error;
  if (preview.incomplete || !preview.count) return "Indique combien le client paie à chaque versement.";
  return null;
}

// Formulaire de vente à crédit : s'ouvre quand le caissier choisit « Crédit ».
// `subtotal` = total du panier. `onSave` reçoit la saisie ; le serveur recalcule tout à la validation.
export default function CreditModal({ open, onClose, subtotal, initial, onSave }) {
  const { auth, updateBusiness } = useAuth();
  const [form, setForm] = useState(initial || EMPTY_CREDIT);
  const [check, setCheck] = useState(null);
  const [showProblem, setShowProblem] = useState(false);
  const refreshed = useRef(false);

  const settings = creditSettings(auth.business);
  const preview = useMemo(
    () => previewCredit(subtotal, settings, termsInputs(form.terms), auth.business?.timezone),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subtotal, form.terms, auth.business],
  );

  // À l'ouverture : on relit les réglages (le propriétaire a pu changer les intérêts) et on repart de la saisie en cours.
  useEffect(() => {
    if (!open) { refreshed.current = false; return; }
    const base = initial || EMPTY_CREDIT;
    const needsDown = base.terms.down === "" && !base.terms.downTouched && preview.minDown > 0;
    setForm(needsDown ? { ...base, terms: { ...base.terms, down: String(preview.minDown) } } : base);
    setCheck(null);
    setShowProblem(false);
    if (!refreshed.current) {
      refreshed.current = true;
      api.get("/business").then((b) => b && updateBusiness(b)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Acompte minimum exigé : proposé tout de suite tant que le caissier n'a pas touché au champ.
  useEffect(() => {
    if (preview.minDown > 0) {
      setForm((f) => (f.terms.downTouched || f.terms.down !== "" ? f : { ...f, terms: { ...f.terms, down: String(preview.minDown) } }));
    }
  }, [preview.minDown]);

  // Ce client (même numéro de pièce) doit-il déjà de l'argent ? Est-il en retard ?
  useEffect(() => {
    if (!open || idKey(form.idNumber).length < 3) { setCheck(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      api.get("/credits/check", { query: { id_number: form.idNumber } })
        .then((r) => alive && setCheck(r))
        .catch(() => alive && setCheck(null));
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [open, form.idNumber]);

  const problem = creditProblem(form, preview);
  const newDebt = check ? check.current_debt + (preview.balance || 0) : 0;
  const overLimit = check && check.max_debt > 0 && !preview.error && newDebt > check.max_debt;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  function save() {
    if (problem) { setShowProblem(true); return; }
    onSave(form);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Vente à crédit"
      wide
      footer={(
        <>
          <Button kind="soft" onClick={onClose}>Annuler</Button>
          <Button onClick={save}>Enregistrer le crédit</Button>
        </>
      )}
    >
      <div className="credit-form">
        <CreditTotals preview={preview} />
        <Field label="Nom du client">
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" aria-label="Nom du client" autoFocus />
        </Field>
        <Field label="Numéro de pièce d'identité" hint="Regarde la vraie pièce du client.">
          <input value={form.idNumber} onChange={(e) => set({ idNumber: e.target.value })} autoComplete="off" aria-label="Numéro de pièce d'identité" />
        </Field>
        {check?.found && (
          <div className={check.overdue_amount > 0 ? "credit-warn red" : "credit-warn"} role="status">
            <b>{check.names.join(", ")}</b> a déjà {check.open_count} crédit{check.open_count > 1 ? "s" : ""} en cours : il doit {fc(check.current_debt)}
            {check.overdue_amount > 0 ? <>, dont <b>{fc(check.overdue_amount)} en retard</b>.</> : "."}
            {check.max_debt > 0 && <> Il peut encore emprunter {fc(check.available)}.</>}
          </div>
        )}
        {overLimit && (
          <div className="credit-warn red" role="alert">
            Ce crédit dépasse la limite de {fc(check.max_debt)} par client. Le propriétaire devra valider avec son mot de passe.
          </div>
        )}
        <Field label="Téléphone du client" hint="Pour les rappels de paiement.">
          <input type="tel" inputMode="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} autoComplete="off" aria-label="Téléphone du client" />
        </Field>
        <CreditTermsFields value={form.terms} onChange={(terms) => set({ terms })} minDown={preview.minDown} />
        <CreditPreview preview={preview} hideTotals />
        {showProblem && problem && <div className="credit-error" role="alert">{problem}</div>}
      </div>
    </Modal>
  );
}
