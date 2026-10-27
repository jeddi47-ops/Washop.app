// Réapprovisionnement : quantité à ajouter, sans motif (cahier 4.5). Tracé par le backend.
import { useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import "../stock-smart.css";
import { api } from "../lib/api";
import { parseNumber, qty } from "../lib/format";
import { useAuth } from "../state/auth";
import { stockThreshold, useProducts } from "../state/data";
import { errorText, useToast } from "../state/toast";
import { Button, Field, Modal, StockBadge, Thumb } from "./ui";

export default function RestockModal({ product, onClose, onDone }) {
  const { auth, isOwner } = useAuth();
  const { upsert } = useProducts();
  const toast = useToast();
  const [value, setValue] = useState("1");
  const [cost, setCost] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setValue("1");
    setCost(product?.purchase_price != null ? String(product.purchase_price).replace(".", ",") : "");
  }, [product?.id]);
  if (!product) return null;

  const n = parseNumber(value);
  const valid = Number.isFinite(n) && n > 0;
  const costN = parseNumber(cost);
  const costValid = !isOwner || cost === "" || (Number.isFinite(costN) && costN >= 0);
  const step = (d) => setValue(String(Math.max(1, (Number.isFinite(n) ? n : 0) + d)));

  async function submit() {
    setLoading(true);
    try {
      const updated = await api.post(`/products/${product.id}/stock`, { quantity_change: n, type: "restock", ...(isOwner && cost !== "" && Number.isFinite(costN) ? { unit_cost: costN } : {}) });
      upsert(updated);
      toast.push(`Stock ajouté : ${updated.name} (${qty(updated.quantity)})`, "success");
      onDone?.(updated);
      onClose();
    } catch (e) {
      toast.push(errorText(e), "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Réapprovisionner" footer={<Button className="btn-block btn-lg" icon={Boxes} disabled={!valid || !costValid} loading={loading} onClick={submit}>Réapprovisionner</Button>}>
      <div className="restock-product">
        <Thumb name={product.name} size={52} />
        <div><strong>{product.name}</strong><span className="muted">Stock actuel {qty(product.quantity)} · seuil {qty(stockThreshold(product, auth.business))}</span></div>
        <StockBadge product={product} business={auth.business} normalLabel="normal" />
      </div>
      <div className="restock-label">Quantité à ajouter</div>
      <div className="restock-stepper">
        <button type="button" aria-label="Moins" onClick={() => step(-1)}>−</button>
        <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Quantité à ajouter" className="num" />
        <button type="button" aria-label="Plus" onClick={() => step(1)}>+</button>
      </div>
      {isOwner && (
        <Field label="Prix d'achat unitaire (FC)" hint="Sert à calculer le fonds de réappro. Vide : prix d'achat du produit." className="ssm-field">
          <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} aria-label="Prix d'achat unitaire" />
        </Field>
      )}
      {valid && <div className="restock-after">Nouveau stock : <b>{qty(Number(product.quantity) + n)}</b></div>}
    </Modal>
  );
}
