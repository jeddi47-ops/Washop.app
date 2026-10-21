// Paramètres (propriétaire) : informations du commerce. Les onglets Boutique, Sécurité, Notifications ne sont pas livrés.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../lib/api";
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

  useEffect(() => {
    api.get("/business").then((b) => { updateBusiness(b); setF({ name: b.name || "", address: b.address || "", phone: b.phone || "" }); }).catch((e) => toast.push(errorText(e), "error"));
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
        <div className="card logo-card">
          <span className="field-label">Logo</span>
          <span className="shop-logo" aria-hidden="true">{letter}</span>
          <span className="muted">Logo par défaut.</span>
        </div>
      </div>
    </div>
  );
}
