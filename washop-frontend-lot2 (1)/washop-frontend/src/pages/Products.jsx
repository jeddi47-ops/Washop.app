import { useMemo, useState } from "react";
import { ChevronRight, Package, Plus, Search, X } from "lucide-react";
import { fc, qty } from "../lib/format";
import { useRouter } from "../lib/router";
import { useIsDesktop } from "../lib/useMedia";
import { useAuth } from "../state/auth";
import { useProducts } from "../state/data";
import { Button, Empty, Spinner, StockBadge, Thumb, cx } from "../components/ui";
import { PageHeader } from "../components/Layout";

export default function Products() {
  const { auth, isOwner } = useAuth();
  const { products, categories, loading } = useProducts();
  const { navigate } = useRouter();
  const desktop = useIsDesktop();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState(null);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return products.filter((p) => (!cat || p.category === cat) && (!s || p.name.toLowerCase().includes(s) || (p.code || "").toLowerCase().includes(s)));
  }, [products, q, cat]);

  const open = (p) => navigate(`/produits/${p.id}`);

  return (
    <div className="page">
      <PageHeader
        title="Produits"
        sub={desktop ? `${products.length} produit${products.length > 1 ? "s" : ""} actif${products.length > 1 ? "s" : ""}` : null}
        actions={<Button icon={Plus} onClick={() => navigate("/produits/nouveau")}>{desktop ? "Ajouter un produit" : "Ajouter"}</Button>}
      />
      <div className="toolbar">
        <div className="search">
          <Search size={18} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom ou code" aria-label="Rechercher" />
          {q && <button type="button" aria-label="Effacer" onClick={() => setQ("")}><X size={16} /></button>}
        </div>
        {categories.length > 0 && (
          <div className="chips">
            <button type="button" className={cx("chip", !cat && "on")} onClick={() => setCat(null)}>Toutes</button>
            {categories.map((c) => <button key={c} type="button" className={cx("chip", cat === c && "on")} onClick={() => setCat(c)}>{c}</button>)}
          </div>
        )}
      </div>

      {loading && !products.length ? <Spinner /> : !list.length ? (
        <Empty icon={Package} title={products.length ? "Aucun produit ne correspond" : "Aucun produit"} text={products.length ? "Change la recherche ou la catégorie." : "Ajoute ton premier produit pour commencer à vendre."} />
      ) : desktop ? (
        <table className="table">
          <thead>
            <tr>
              <th>Produit</th><th>Catégorie</th><th className="r">Prix de vente</th>
              {isOwner && <th className="r">Prix d'achat</th>}
              <th className="r">Stock</th><th>Statut</th><th aria-label="Ouvrir" />
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => open(p)}>
                <td><div className="cell-product"><Thumb name={p.name} size={40} /><div><strong>{p.name}</strong><span className="mono">{p.code}</span></div></div></td>
                <td className="muted">{p.category || "—"}</td>
                <td className="r num strong">{fc(p.sale_price)}</td>
                {isOwner && <td className="r num muted">{fc(p.purchase_price)}</td>}
                <td className="r num strong">{qty(p.quantity)}</td>
                <td><StockBadge product={p} business={auth.business} /></td>
                <td className="r muted"><ChevronRight size={18} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="rows">
          {list.map((p) => (
            <button key={p.id} type="button" className="row" onClick={() => open(p)}>
              <Thumb name={p.name} size={48} />
              <div className="row-main"><strong>{p.name}</strong><span>{p.category ? `${p.category} · ` : ""}{qty(p.quantity)} en stock</span></div>
              <div className="row-end"><b className="num">{fc(p.sale_price)}</b><StockBadge product={p} business={auth.business} /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
