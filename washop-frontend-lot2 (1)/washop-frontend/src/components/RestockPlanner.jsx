// « À racheter » : quoi racheter, en quelle quantité, avec le fonds de réappro, et le bon de commande PDF par fournisseur.
// Calcul pur côté serveur (aucune IA). Propriétaire uniquement.
import { useEffect, useMemo, useState } from "react";
import { FileText, ShoppingBasket } from "lucide-react";
import { api, openBlob } from "../lib/api";
import { fc, qty } from "../lib/format";
import { errorText, useToast } from "../state/toast";
import { Badge, Button, Segmented, Stepper, Thumb, cx } from "./ui";
import "../stock-smart.css";

const COVER = [{ code: 7, label: "1 semaine" }, { code: 14, label: "2 semaines" }, { code: 30, label: "1 mois" }];
const TIERS = { rupture: ["rupture", "Rupture"], bientot: ["faible", "Bientôt en rupture"], prevoir: ["normal", "À prévoir"] };
const NO_SUPPLIER = "";

export default function RestockPlanner({ rev }) {
  const toast = useToast();
  const [cover, setCover] = useState(14);
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    api.get("/stock/suggestions", { query: { cover_days: cover } }).then((d) => {
      if (!alive) return;
      setData(d);
      setFailed(false);
      // Les lignes que le fonds permet d'acheter sont cochées d'office, avec la quantité financée.
      setSel(Object.fromEntries(d.lines.map((l) => [l.product_id, { on: l.funded_qty > 0, qty: l.funded_qty > 0 ? l.funded_qty : l.suggested_qty }])));
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [cover, rev]);

  const chosen = useMemo(() => (data ? data.lines.filter((l) => sel[l.product_id]?.on) : []), [data, sel]);
  const total = chosen.reduce((s, l) => s + sel[l.product_id].qty * l.unit_cost, 0);
  const left = data?.started ? data.budget - total : null;

  // Un bon de commande par fournisseur.
  const groups = useMemo(() => {
    const map = new Map();
    chosen.forEach((l) => {
      const key = l.supplier || NO_SUPPLIER;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(l);
    });
    return [...map.entries()].sort((a, b) => (a[0] === NO_SUPPLIER) - (b[0] === NO_SUPPLIER) || a[0].localeCompare(b[0], "fr"));
  }, [chosen]);

  const patch = (id, change) => setSel((s) => ({ ...s, [id]: { ...s[id], ...change } }));

  async function makePdf(key, lines) {
    setBusy(key);
    try {
      await openBlob("POST", "/stock/purchase-order/pdf", {
        supplier: key || null,
        lines: lines.map((l) => ({ product_id: l.product_id, quantity: sel[l.product_id].qty })),
      });
    } catch (e) {
      toast.push(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  if (failed) return null;
  return (
    <section className="ssm-card">
      <div className="ssm-head">
        <div>
          <h2><ShoppingBasket size={16} /> À racheter</h2>
          <span className="muted">De quoi tenir {cover === 7 ? "1 semaine" : cover === 14 ? "2 semaines" : "1 mois"} au rythme de tes ventes</span>
        </div>
        <Segmented className="segmented-sm" options={COVER} value={cover} onChange={setCover} />
      </div>

      {data === null ? <div className="muted">…</div> : (
        <>
          {!data.started && <p className="ssm-note">Démarre le suivi du fonds plus haut pour que Washop limite les achats à l'argent disponible.</p>}
          {data.started && data.budget <= 0 && data.lines.length > 0 && <p className="ssm-note ssm-note-warn">Pas de fonds disponible pour l'instant : voici ce qui manque, à acheter quand tu auras vendu.</p>}

          {!data.lines.length ? (
            <p className="muted">Rien à racheter : tes stocks couvrent déjà {cover === 7 ? "une semaine" : cover === 14 ? "deux semaines" : "un mois"} de ventes.</p>
          ) : (
            <ul className="ssm-lines">
              {data.lines.map((l) => {
                const s = sel[l.product_id] || { on: false, qty: l.suggested_qty };
                const [kind, label] = TIERS[l.tier];
                const unfunded = data.started && l.funded_qty === 0;
                return (
                  <li key={l.product_id} className={cx("ssm-line", !s.on && "off")}>
                    <input type="checkbox" className="ssm-check" checked={s.on} onChange={(e) => patch(l.product_id, { on: e.target.checked })} aria-label={`Racheter ${l.name}`} />
                    <div className="ssm-product">
                      <Thumb name={l.name} size={36} />
                      <div>
                        <strong>{l.name}</strong>
                        <span className="muted">{l.supplier || "Sans fournisseur"} · {fc(l.unit_cost)} l'unité</span>
                      </div>
                    </div>
                    <div className="ssm-stockinfo">
                      <Badge kind={kind}>{label}</Badge>
                      <span className="muted">{qty(l.quantity)} en stock · {l.days_left > 0 ? `${qty(l.days_left)} j restants` : "épuisé"}</span>
                    </div>
                    <div className="ssm-qty">
                      <Stepper value={s.qty} min={1} onChange={(v) => patch(l.product_id, { qty: v, on: true })} />
                      {data.started && l.funded_qty < l.suggested_qty && (
                        <span className="ssm-short">{unfunded ? `Il en faudrait ${qty(l.suggested_qty)}` : `Fonds pour ${qty(l.funded_qty)} sur ${qty(l.suggested_qty)}`}</span>
                      )}
                    </div>
                    <b className="num ssm-linetotal">{fc(s.qty * l.unit_cost)}</b>
                  </li>
                );
              })}
            </ul>
          )}

          {data.missing_cost.length > 0 && (
            <p className="ssm-note">Prix d'achat manquant, donc pas dans la liste : {data.missing_cost.map((m) => m.name).join(", ")}.</p>
          )}

          {data.lines.length > 0 && (
            <div className="ssm-summary">
              <div>
                <span className="muted">Sélection · {chosen.length} produit{chosen.length > 1 ? "s" : ""}</span>
                <b className="ssm-sum-total num">{fc(total)}</b>
                {left !== null && (
                  <span className={cx("ssm-left num", left < 0 && "red")}>
                    {left < 0 ? `Dépasse le fonds de ${fc(-left)}` : `Il restera ${fc(left)} dans le fonds`}
                  </span>
                )}
              </div>
              <div className="ssm-pdfs">
                {groups.length === 0 && <Button icon={FileText} disabled>Bon de commande (PDF)</Button>}
                {groups.map(([key, lines]) => (
                  <Button key={key || "none"} icon={FileText} loading={busy === key} onClick={() => makePdf(key, lines)}>
                    {groups.length === 1 ? "Bon de commande (PDF)" : `PDF · ${key || "Sans fournisseur"}`}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
