// Paramètres (propriétaire) : informations du commerce. Les onglets Boutique, Sécurité, Notifications ne sont pas livrés.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../lib/api";
import { parseNumber } from "../lib/format";
import { creditSettings } from "../lib/credit";
import { useAuth } from "../state/auth";
import { errorText, useToast } from "../state/toast";
import { Button, Field } from "../components/ui";
import { PageHeader } from "../components/Layout";

export default function Settings() {
  const { auth, updateBusiness } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ name: "", address: "", phone: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cr, setCr] = useState({ enabled: true, interest: "0", minDown: "0", maxDebt: "0", country: "" });
  const [crLoading, setCrLoading] = useState(false);
  const [crError, setCrError] = useState(null);

  useEffect(() => {
    api.get("/business").then((b) => {
      updateBusiness(b);
      setF({ name: b.name || "", address: b.address || "", phone: b.phone || "" });
      const c = creditSettings(b);
      setCr({
        enabled: c.credit_enabled !== false,
        interest: String(c.credit_interest_percent ?? 0).replace(".", ","),
        minDown: String(c.credit_min_down_percent ?? 0).replace(".", ","),
        maxDebt: String(c.credit_max_debt ?? 0),
        country: c.phone_country_code || "",
      });
    }).catch((e) => toast.push(errorText(e), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    if (!f.name.trim()) { setError("Le nom du commerce est obligatoire."); return; }
    setError(null);
    setLoading(true);
    try {
      // Champ vide = pas de changement côté backend (il ignore les valeurs nulles).
      const b = await api.put("/business", { name: f.name.trim(), address: f.address.trim() || undefined, phone: f.phone.trim() || undefined });
      updateBusiness(b);
      toast.push("Informations enregistrées.", "success");
    } catch (err) { toast.push(errorText(err), "error"); } finally { setLoading(false); }
  }

  async function saveCredit(e) {
    e.preventDefault();
    const interest = parseNumber(cr.interest);
    const minDown = parseNumber(cr.minDown);
    const maxDebt = parseNumber(cr.maxDebt);
    if (![interest, minDown].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) { setCrError("Les pourcentages doivent être entre 0 et 100."); return; }
    if (!Number.isFinite(maxDebt) || maxDebt < 0) { setCrError("La limite de dette doit être 0 ou plus."); return; }
    if (!/^\d{0,4}$/.test(cr.country.trim())) { setCrError("L'indicatif du pays ne contient que des chiffres (ex. 243)."); return; }
    setCrError(null);
    setCrLoading(true);
    try {
      const b = await api.put("/business", { settings: {
        credit_enabled: cr.enabled, credit_interest_percent: interest, credit_min_down_percent: minDown,
        credit_max_debt: maxDebt, phone_country_code: cr.country.trim(),
      } });
      updateBusiness(b);
      toast.push("Réglages du crédit enregistrés.", "success");
    } catch (err) { toast.push(errorText(err), "error"); } finally { setCrLoading(false); }
  }

  const letter = (f.name || auth.business?.name || "W").trim().charAt(0).toUpperCase();

  return (
    <div className="page">
      <PageHeader title="Paramètres" sub="Informations du commerce, imprimées sur les reçus." />
      <div className="settings-grid">
        <form className="card stack" onSubmit={save} noValidate>
          <Field label="Nom du commerce" error={error}><input value={f.name} onChange={set("name")} maxLength={120} /></Field>
          <Field label="Adresse"><input value={f.address} onChange={set("address")} maxLength={255} /></Field>
          <Field label="Téléphone"><input value={f.phone} onChange={set("phone")} inputMode="tel" maxLength={30} /></Field>
          <div className="form-actions"><span className="grow" /><Button type="submit" icon={Check} loading={loading}>Enregistrer</Button></div>
        </form>
        <form className="card stack" onSubmit={saveCredit} noValidate>
          <strong>Vente à crédit</strong>
          <label className="check-row">
            <input type="checkbox" checked={cr.enabled} onChange={(e) => setCr((x) => ({ ...x, enabled: e.target.checked }))} />
            <span>Autoriser la vente à crédit à la caisse</span>
          </label>
          <Field label="Intérêts ajoutés au prix (%)" hint="Ex. 15 : un panier de 100 000 FC devient 115 000 FC. Vérifie la loi de ton pays sur les taux.">
            <input inputMode="decimal" value={cr.interest} onChange={(e) => setCr((x) => ({ ...x, interest: e.target.value }))} />
          </Field>
          <Field label="Acompte minimum exigé (% du total)" hint="0 = pas d'acompte obligatoire.">
            <input inputMode="decimal" value={cr.minDown} onChange={(e) => setCr((x) => ({ ...x, minDown: e.target.value }))} />
          </Field>
          <Field label="Dette maximale par client" hint="Même limite pour tous. 0 = pas de limite. Au-delà, ton mot de passe est demandé à la caisse.">
            <input inputMode="decimal" value={cr.maxDebt} onChange={(e) => setCr((x) => ({ ...x, maxDebt: e.target.value }))} />
          </Field>
          <Field label="Indicatif téléphonique du pays" hint="Ex. 243. Sert aux liens WhatsApp quand le numéro commence par 0.">
            <input inputMode="numeric" value={cr.country} maxLength={4} onChange={(e) => setCr((x) => ({ ...x, country: e.target.value }))} />
          </Field>
          {crError && <div className="credit-error" role="alert">{crError}</div>}
          <div className="form-actions"><span className="grow" /><Button type="submit" icon={Check} loading={crLoading}>Enregistrer</Button></div>
        </form>
        <div className="card logo-card">
          <span className="field-label">Logo</span>
          <span className="shop-logo" aria-hidden="true">{letter}</span>
          <span className="muted">Logo par défaut.</span>
        </div>
      </div>
    </div>
  );
}
