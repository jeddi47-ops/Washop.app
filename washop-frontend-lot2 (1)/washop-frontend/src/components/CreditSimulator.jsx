import { useMemo, useState } from "react";
import { parseNumber } from "../lib/format";
import { creditSettings, previewCredit } from "../lib/credit";
import { useAuth } from "../state/auth";
import { Button, Field, Modal } from "./ui";
import CreditPreview from "./CreditPreview";
import CreditTermsFields from "./CreditTermsFields";
import "../credit.css";

// Simulateur : le commerçant ou le client voit le calendrier AVANT la vente (aucun enregistrement, aucun panier).
export default function CreditSimulator({ open, onClose }) {
  const { auth } = useAuth();
  const settings = creditSettings(auth.business);
  const [price, setPrice] = useState("");
  const [terms, setTerms] = useState({ down: "", frequency: "weekly", by: "count", installment: "", count: "4" });

  const preview = useMemo(
    () => previewCredit(parseNumber(price) || 0, settings, {
      down: parseNumber(terms.down), frequency: terms.frequency, by: terms.by,
      installment: parseNumber(terms.installment), count: parseNumber(terms.count),
    }, auth.business?.timezone),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [price, terms, auth.business],
  );
  const hasPrice = (parseNumber(price) || 0) > 0;

  return (
    <Modal open={open} onClose={onClose} title="Simulateur de crédit" wide footer={<Button kind="soft" onClick={onClose}>Fermer</Button>}>
      <div className="credit-form">
        <p className="muted">Rien n'est enregistré. Les intérêts et l'acompte minimum sont ceux de la boutique.</p>
        <Field label="Prix des articles">
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Ex. 100 000" aria-label="Prix des articles" autoFocus />
        </Field>
        <CreditTermsFields value={terms} onChange={setTerms} minDown={preview.minDown} />
        {hasPrice && <CreditPreview preview={{ ...preview, frequency: terms.frequency }} maxRows={12} />}
      </div>
    </Modal>
  );
}
