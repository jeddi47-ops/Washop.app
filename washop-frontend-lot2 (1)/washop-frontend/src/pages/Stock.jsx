import { useCallback, useMemo, useState } from "react";
import { Boxes, Plus, Search, X } from "lucide-react";
import { qty } from "../lib/format";
import { useIsDesktop } from "../lib/useMedia";
import { useAuth } from "../state/auth";
import { stockStatus, stockThreshold, useProducts } from "../state/data";
import { Badge, Button, Empty, Spinner, Thumb, cx } from "../components/ui";
import { PageHeader } from "../components/Layout";
import RestockModal from "../components/RestockModal";
import RestockPlanner from "../components/RestockPlanner";
import { FundPanel, WinnersPanel } from "../components/StockInsights";

// Pas de bouton « Exporter » : le backend du lot 2 n'a pas de route d'export (cahier 4.5).
const FILTERS = [
  { code: null, label: "Tous" },
  { code: "faible", label: "Stock faible" },
  { code: "rupture", label: "Rupture" },
];
const ORDER = { rupture: 0, faible: 1, normal: 2 };

export default function Stock() {
  const { auth, isOwner } = useAuth();
  const { products, loading } = useProducts();
  const desktop = useIsDesktop();
  const [filter, setFilter] = useState(null);
  const [q, setQ] = useState("");
  const [target, setTarget] = useState(null);
  // Incrémenté après un réapprovisionnement ou un changement du fonds : les panneaux se rechargent.
  const [rev, setRev] = useState(0);
  const refresh = useCallback(() => setRev((r) => r + 1), []);

  const rows = useMemo(() => products.map((p) => ({ p, s: stockStatus(p, auth.business) })), [products, auth.business]);
  const counts = useMemo(() => rows.reduce((c, r) => ({ ...c, [r.s]: (c[r.s] || 0) + 1 }), {}), [rows]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows
      .filter((r) => (!filter || r.s === filter) && (!s || r.p.name.toLowerCase().includes(s)))
      .sort((a, b) => ORDER[a.s] - ORDER[b.s] || a.p.name.localeCompare(b.p.name, "fr"));
  }, [rows, filter, q]);

  const current = target ? products.find((p) => p.id === target) : null;

  return (
    <div className="page">
      <PageHeader title="Stock" sub={desktop ? "Chaque réapprovisionnement est tracé dans le journal." : null} />
      <div className="ssm-stack">
        {isOwner && <FundPanel rev={rev} onChanged={refresh} />}
        <WinnersPanel isOwner={isOwner} rev={rev} />
        {isOwner && <RestockPlanner rev={rev} />}
      </div>
      <h2 className="ssm-h2">Tous les produits</h2>
      <div className="stock-counts">
        {[["normal", "Normal"], ["faible", "Stock faible"], ["rupture", "Rupture"]].map(([k]) => (
          <div key={k} className="tile stock-count"><b className="num">{counts[k] || 0}</b><Badge kind={k} /></div>
        ))}
      </div>
      <div className="toolbar">
        <div className="search">
          <Search size={18} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un produit" aria-label="Rechercher" />
          {q && <button type="button" aria-label="Effacer" onClick={() => setQ("")}><X size={16} /></button>}
        </div>
        <div className="chips">{FILTERS.map((f) => <button key={f.label} type="button" className={cx("chip", filter === f.code && "on")} onClick={() => setFilter(f.code)}>{f.label}</button>)}</div>
      </div>
      {loading && !products.length ? <Spinner /> : !list.length ? (
        <Empty icon={Boxes} title="Rien à afficher" text={products.length ? "Aucun produit dans ce filtre." : "Ajoute des produits pour suivre leur stock."} />
      ) : desktop ? (
        <table className="table">
          <thead><tr><th>Produit</th><th className="r">Stock actuel</th><th className="r">Seuil</th><th>Statut</th><th aria-label="Action" /></tr></thead>
          <tbody>
            {list.map(({ p, s }) => (
              <tr key={p.id}>
                <td><div className="cell-product"><Thumb name={p.name} size={40} /><strong>{p.name}</strong></div></td>
                <td className={cx("r num big", s === "rupture" && "red")}>{qty(p.quantity)}</td>
                <td className="r num muted">{qty(stockThreshold(p, auth.business))}</td>
                <td><Badge kind={s} /></td>
                <td className="r"><Button kind="soft" size="sm" icon={Plus} onClick={() => setTarget(p.id)}>Réapprovisionner</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="rows">
          {list.map(({ p, s }) => (
            <div key={p.id} className="row">
              <Thumb name={p.name} size={44} />
              <div className="row-main"><strong>{p.name}</strong><span>Seuil {qty(stockThreshold(p, auth.business))} · <Badge kind={s} /></span></div>
              <b className={cx("num row-qty", s === "rupture" && "red")}>{qty(p.quantity)}</b>
              <button type="button" className="icon-btn icon-btn-accent" aria-label={`Réapprovisionner ${p.name}`} onClick={() => setTarget(p.id)}><Plus size={20} /></button>
            </div>
          ))}
        </div>
      )}
      {current && <RestockModal product={current} onClose={() => setTarget(null)} onDone={refresh} />}
    </div>
  );
}
