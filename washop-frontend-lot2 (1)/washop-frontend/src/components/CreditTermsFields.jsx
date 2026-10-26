import { fc } from "../lib/format";
import { FREQUENCIES } from "../lib/credit";
import { Field, Segmented } from "./ui";
import "../credit.css";

const BY = [
  { code: "amount", label: "Montant par versement" },
  { code: "count", label: "Nombre de versements" },
];

// Champs communs au formulaire de crédit et au simulateur : acompte, rythme, et montant OU nombre de versements.
// value = { down, frequency, by, installment, count } (chaînes saisies) ; onChange reçoit un nouvel objet.
export default function CreditTermsFields({ value, onChange, minDown = 0 }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <>
      <Field label="Acompte payé maintenant" hint={minDown > 0 ? `Minimum exigé par la boutique : ${fc(minDown)}` : "Facultatif"}>
        <input inputMode="decimal" value={value.down} onChange={(e) => set({ down: e.target.value, downTouched: true })} placeholder="0" aria-label="Acompte" />
      </Field>
      <Field label="Le client paie">
        <Segmented options={FREQUENCIES} value={value.frequency} onChange={(frequency) => set({ frequency })} />
      </Field>
      <Field label="Je fixe">
        <Segmented options={BY} value={value.by} onChange={(by) => set({ by })} />
      </Field>
      {value.by === "count" ? (
        <Field label="Nombre de versements">
          <input inputMode="numeric" value={value.count} onChange={(e) => set({ count: e.target.value })} placeholder="Ex. 4" aria-label="Nombre de versements" />
        </Field>
      ) : (
        <Field label="Montant de chaque versement">
          <input inputMode="decimal" value={value.installment} onChange={(e) => set({ installment: e.target.value })} placeholder="Ex. 20 000" aria-label="Montant de chaque versement" />
        </Field>
      )}
    </>
  );
}
