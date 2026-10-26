// Ventes : propriétaire = toutes les ventes ; caissier = son dernier reçu uniquement (MySales).
import { useCallback, useEffect, useState } from "react";
import { Ban, ChevronLeft, ChevronRight, FileText, Receipt as ReceiptIcon, X } from "lucide-react";
import { api, openBlob } from "../lib/api";
import { fc, formatDateTime, qty } from "../lib/format";
import { paymentLabel } from "../lib/labels";
import { useIsDesktop } from "../lib/useMedia";
import { cancelSale } from "../lib/cancelSale";
import { useAuth } from "../state/auth";
import { useProducts } from "../state/data";
import { errorText, useToast } from "../state/toast";
import { Button, ConfirmModal, Empty, Modal, SaleBadge, Spinner, cx } from "../components/ui";
import { PageHeader } from "../components/Layout";
import Receipt from "../components/Receipt";
import { useMotifFlow } from "../components/useMotifFlow";
import "../credit.css";

const PAGE_SIZE = 20;

function SaleDetail({ sale, onCancelled, onClose }) {
  const toast = useToast();
  const { reload } = useProducts();
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  async function doCancel() {
    setLoading(true);
    try {
      const s = await cancelSale(sale.id, null);
      setConfirm(false);
      onCancelled(s);
      reload();
      toast.push("Vente annulée.", "success");
    } catch (e) { toast.push(errorText(e), "error"); } finally { setLoading(false); }
  }

  return (
    <div className="sale-detail">
      <div className="sale-detail-head">
        <div><span className="mono muted">{sale.number}</span><b className="num">{fc(sale.total)}</b></div>
        <SaleBadge status={sale.status} credit={sale.payment_method === "credit"} />
        {onClose && <button type="button" className="icon-btn" aria-label="Fermer" onClick={onClose}><X size={18} /></button>}
      </div>
      <div className="muted">{sale.cashier_name || "—"} · {paymentLabel(sale.payment_method)} · {formatDateTime(sale.created_at)}</div>
      <div className="lines">
        {sale.items.map((it) => (
          <div key={it.product_id} className="line"><span>{qty(it.quantity)} × {it.name}</span><b className="num">{fc(it.line_total)}</b></div>
        ))}
      </div>
      {sale.change_given != null && <div className="line muted"><span>Reçu {fc(sale.amount_received)}</span><span>Monnaie {fc(sale.change_given)}</span></div>}
      {sale.credit && (
        <div className="receipt-credit">
          <div className="line"><span>Vente à crédit · {sale.credit.customer_name}</span><b className="num">{fc(sale.credit.total_due)}</b></div>
          <div className="line muted"><span>Acompte {fc(sale.credit.down_payment)}</span><span>Reste à la vente {fc(sale.credit.balance)}</span></div>
          <div className="line muted"><span>Le suivi et les remboursements sont dans l'onglet Crédits.</span></div>
        </div>
      )}
      <div className="section-label">Journal de la vente</div>
      <ol className="timeline">
        <li><i className="dot-green" /><span><b>Vente créée</b> · {sale.cashier_name || "—"} · {formatDateTime(sale.created_at)}</span></li>
        {sale.status === "cancelled" && (
          <li><i className="dot-red" /><span><b>Vente annulée</b> · {formatDateTime(sale.cancelled_at)}{sale.cancel_reason ? ` · ${sale.cancel_reason}` : ""}</span></li>
        )}
      </ol>
      <div className="sale-detail-actions">
        <Button kind="ghost" icon={FileText} onClick={() => openBlob("GET", `/sales/${sale.id}/invoice`).catch((e) => toast.push(errorText(e), "error"))}>Facture</Button>
        {sale.status === "completed" && <Button kind="danger" icon={Ban} onClick={() => setConfirm(true)}>Annuler la vente</Button>}
      </div>
      <ConfirmModal open={confirm} title={`Annuler la vente ${sale.number} ?`} text="Les produits seront remis en stock." confirmLabel="Annuler la vente" danger loading={loading} onClose={() => setConfirm(false)} onConfirm={doCancel} />
    </div>
  );
}

export default function Sales() {
  const desktop = useIsDesktop();
  const toast = useToast();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get("/sales", { query: { date_from: from, date_to: to, page, page_size: PAGE_SIZE } });
      setData(res);
    } catch (e) { toast.push(errorText(e), "error"); setData({ items: [], total: 0 }); }
  }, [from, to, page, toast]);

  useEffect(() => { load(); }, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const replace = (s) => { setSelected(s); setData((d) => ({ ...d, items: d.items.map((x) => (x.id === s.id ? s : x)) })); };

  const filters = (
    <div className="toolbar">
      <label className="date-filter"><span>Du</span><input type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></label>
      <label className="date-filter"><span>au</span><input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></label>
      {(from || to) && <Button kind="soft" size="sm" onClick={() => { setFrom(""); setTo(""); setPage(1); }}>Effacer</Button>}
    </div>
  );

  const pager = data && data.total > PAGE_SIZE && (
    <div className="pager">
      <span className="muted">{(page - 1) * PAGE_SIZE + 1} – {Math.min(page * PAGE_SIZE, data.total)} sur {data.total}</span>
      <div>
        <button type="button" className="icon-btn" aria-label="Page précédente" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={16} /></button>
        <span className="num">{page} / {pages}</span>
        <button type="button" className="icon-btn" aria-label="Page suivante" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={16} /></button>
      </div>
    </div>
  );

  const body = !data ? <Spinner /> : !data.items.length ? (
    <Empty icon={ReceiptIcon} title="Aucune vente" text={from || to ? "Aucune vente sur cette période." : "Les ventes apparaîtront ici."} />
  ) : desktop ? (
    <table className="table">
      <thead><tr><th>N°</th><th>Date</th><th>Caissier</th><th>Client</th><th className="r">Montant</th><th>Statut</th></tr></thead>
      <tbody>
        {data.items.map((s) => (
          <tr key={s.id} className={cx("clickable", selected?.id === s.id && "selected")} onClick={() => setSelected(s)}>
            <td className="mono strong nowrap">{s.number}</td>
            <td className="muted nowrap">{formatDateTime(s.created_at)}</td>
            <td>{s.cashier_name || "—"}</td>
            <td className="muted">—</td>
            <td className="r num strong">{fc(s.total)}</td>
            <td><SaleBadge status={s.status} credit={s.payment_method === "credit"} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : (
    <div className="rows">
      {data.items.map((s) => (
        <button key={s.id} type="button" className="row" onClick={() => setSelected(s)}>
          <div className="row-main"><strong>{s.cashier_name || "—"}</strong><span><span className="mono">{s.number}</span> · {formatDateTime(s.created_at)}</span></div>
          <div className="row-end"><b className="num">{fc(s.total)}</b><SaleBadge status={s.status} credit={s.payment_method === "credit"} /></div>
        </button>
      ))}
    </div>
  );

  return (
    <div className="page">
      <PageHeader title="Ventes" sub={desktop ? "Toutes les ventes du commerce" : null} />
      {filters}
      {desktop ? (
        <div className="split">
          <div className="split-main">{body}{pager}</div>
          <aside className="card split-side">
            {selected ? <SaleDetail sale={selected} onCancelled={replace} /> : <p className="muted">Choisis une vente pour voir son détail.</p>}
          </aside>
        </div>
      ) : (
        <>
          {body}{pager}
          <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title="Détail de la vente">
            {selected && <SaleDetail sale={selected} onCancelled={replace} />}
          </Modal>
        </>
      )}
    </div>
  );
}

export function MySales() {
  const { auth } = useAuth();
  const toast = useToast();
  const { reload } = useProducts();
  const motif = useMotifFlow();
  const [sale, setSale] = useState(undefined);

  useEffect(() => {
    api.get("/sales").then((r) => setSale(r.items[0] || null)).catch((e) => { toast.push(errorText(e), "error"); setSale(null); });
  }, [toast]);

  return (
    <div className="page page-narrow">
      <PageHeader title="Mes ventes" sub="Ton dernier reçu" />
      {sale === undefined ? <Spinner /> : !sale ? (
        <Empty icon={ReceiptIcon} title="Aucune vente pour l'instant" text="Ton dernier reçu apparaîtra ici." />
      ) : (
        <div className="mysale">
          <Receipt sale={sale} business={auth.business} />
          <div className="receipt-actions">
            <Button kind="ghost" icon={FileText} onClick={() => openBlob("GET", `/sales/${sale.id}/invoice`).catch((e) => toast.push(errorText(e), "error"))}>Facture PDF</Button>
            {sale.status === "completed" && sale.payment_method !== "credit" && (
              <Button kind="danger" icon={Ban} onClick={() => motif.start({
                title: "Pourquoi annuler cette vente ?",
                subtitle: `${sale.number} · ${fc(sale.total)}`,
                run: (m) => cancelSale(sale.id, m),
                onDone: (s) => { setSale(s); reload(); toast.push("Vente annulée.", "success"); },
              })}>Annuler cette vente</Button>
            )}
          </div>
        </div>
      )}
      {motif.modal}
    </div>
  );
}
