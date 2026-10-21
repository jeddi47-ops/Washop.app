// Journal d'audit : lecture seule, propriétaire uniquement. Aucun bouton de modification ni de suppression.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ScrollText } from "lucide-react";
import { api, fetchAllProducts } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { ACTION_LABELS, actionTone, formatAuditValue, motifLabel } from "../lib/labels";
import { useIsDesktop } from "../lib/useMedia";
import { errorText, useToast } from "../state/toast";
import { Button, Empty, Spinner } from "../components/ui";
import { PageHeader } from "../components/Layout";

const PAGE_SIZE = 50;

function targetLabel(e, products, users) {
  if (e.target_type === "product") return products[e.target_id] || e.new_value?.name || "Produit";
  if (e.target_type === "sale") return e.new_value?.number || "Vente";
  if (e.target_type === "user") return users[e.target_id] || e.new_value?.name || "Utilisateur";
  if (e.target_type === "session") return `Session · ${(e.device_type || e.old_value?.device_type || e.new_value?.device_type) === "scanner" ? "scanner" : "caisse"}`;
  return e.target_type || "—";
}

function motifText(e) {
  if (!e.motif_code && !e.motif_note) return "—";
  return [motifLabel(e.motif_code), e.motif_note].filter(Boolean).join(" · ");
}

export default function Audit() {
  const toast = useToast();
  const desktop = useIsDesktop();
  const [filters, setFilters] = useState({ date_from: "", date_to: "", user_id: "", action: "", product_id: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [products, setProducts] = useState([]);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    fetchAllProducts({ includeArchived: true }).then(setProducts).catch(() => {});
    api.get("/users").then((r) => setUsers(r.items)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setData(null);
    try { setData(await api.get("/audit-log", { query: { ...filters, page, page_size: PAGE_SIZE } })); }
    catch (e) { toast.push(errorText(e), "error"); setData({ items: [], total: 0 }); }
  }, [filters, page, toast]);
  useEffect(() => { load(); }, [load]);

  const productNames = useMemo(() => Object.fromEntries(products.map((p) => [p.id, p.name])), [products]);
  const userNames = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);
  const set = (k) => (ev) => { setFilters((f) => ({ ...f, [k]: ev.target.value })); setPage(1); };
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const hasFilter = Object.values(filters).some(Boolean);

  return (
    <div className="page">
      <PageHeader title="Journal" sub={desktop ? "Qui a fait quoi, quand et pourquoi. Lecture seule." : null} />
      <div className="toolbar filters">
        <label className="date-filter"><span>Du</span><input type="date" value={filters.date_from} onChange={set("date_from")} /></label>
        <label className="date-filter"><span>au</span><input type="date" value={filters.date_to} onChange={set("date_to")} /></label>
        <select value={filters.user_id} onChange={set("user_id")} aria-label="Utilisateur">
          <option value="">Tous les utilisateurs</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={filters.action} onChange={set("action")} aria-label="Action">
          <option value="">Toutes les actions</option>
          {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={filters.product_id} onChange={set("product_id")} aria-label="Produit">
          <option value="">Tous les produits</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_archived ? " (archivé)" : ""}</option>)}
        </select>
        {hasFilter && <Button kind="soft" size="sm" onClick={() => { setFilters({ date_from: "", date_to: "", user_id: "", action: "", product_id: "" }); setPage(1); }}>Effacer</Button>}
      </div>

      {!data ? <Spinner /> : !data.items.length ? (
        <Empty icon={ScrollText} title="Aucune entrée" text={hasFilter ? "Aucune entrée pour ces filtres." : "Les actions apparaîtront ici."} />
      ) : desktop ? (
        <table className="table table-audit">
          <thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Produit ou vente</th><th>Ancienne valeur</th><th>Nouvelle valeur</th><th>Motif</th></tr></thead>
          <tbody>
            {data.items.map((e) => (
              <tr key={e.id}>
                <td className="num muted nowrap">{formatDateTime(e.created_at)}</td>
                <td>{e.user_name || userNames[e.user_id] || "—"}</td>
                <td><span className={`tag tag-${actionTone(e.action)}`}>{ACTION_LABELS[e.action] || e.action}</span></td>
                <td className="strong">{targetLabel(e, productNames, userNames)}</td>
                <td className="muted">{formatAuditValue(e.old_value)}</td>
                <td className="strong">{formatAuditValue(e.new_value)}</td>
                <td className="muted">{motifText(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="audit-cards">
          {data.items.map((e) => (
            <div key={e.id} className="audit-card">
              <div className="audit-card-top"><span className={`tag tag-${actionTone(e.action)}`}>{ACTION_LABELS[e.action] || e.action}</span><span className="muted num">{formatDateTime(e.created_at)}</span></div>
              <strong>{targetLabel(e, productNames, userNames)}</strong>
              <span className="muted">{e.user_name || userNames[e.user_id] || "—"}</span>
              {(e.old_value || e.new_value) && <span className="audit-change">{formatAuditValue(e.old_value)} → <b>{formatAuditValue(e.new_value)}</b></span>}
              {(e.motif_code || e.motif_note) && <span className="muted">Motif : {motifText(e)}</span>}
            </div>
          ))}
        </div>
      )}
      {data && data.total > PAGE_SIZE && (
        <div className="pager">
          <span className="muted">{(page - 1) * PAGE_SIZE + 1} – {Math.min(page * PAGE_SIZE, data.total)} sur {data.total}</span>
          <div>
            <button type="button" className="icon-btn" aria-label="Page précédente" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={16} /></button>
            <span className="num">{page} / {pages}</span>
            <button type="button" className="icon-btn" aria-label="Page suivante" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={16} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
