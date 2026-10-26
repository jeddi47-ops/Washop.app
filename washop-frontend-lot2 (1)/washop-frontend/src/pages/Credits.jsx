// Crédits clients : liste des dossiers, reste à payer, retards, remboursements et relance WhatsApp.
import { useCallback, useEffect, useState } from "react";
import { Calculator, ChevronLeft, ChevronRight, MessageCircle, Phone, Search, Wallet, X } from "lucide-react";
import { api } from "../lib/api";
import { fc, formatDateTime, parseNumber } from "../lib/format";
import { fmtDay, frequencyLabel, whatsappLink } from "../lib/credit";
import { newId } from "../lib/ids";
import { useRouter } from "../lib/router";
import { useAuth } from "../state/auth";
import { errorText, useToast } from "../state/toast";
import { Badge, Button, Empty, Field, Modal, Spinner, cx } from "../components/ui";
import { PageHeader } from "../components/Layout";
import CreditSimulator from "../components/CreditSimulator";
import "../credit.css";

const PAGE_SIZE = 20;
const FILTERS = [
  { code: "open", label: "En cours" },
  { code: "late", label: "En retard" },
  { code: "week", label: "Cette semaine" },
  { code: "paid", label: "Soldés" },
];

function StatusBadge({ credit }) {
  if (credit.status === "paid") return <Badge kind="payee">Soldé</Badge>;
  if (credit.status === "cancelled") return <Badge kind="annulee">Annulé</Badge>;
  if (credit.is_overdue) return <Badge kind="rupture">En retard · {credit.overdue_days} j</Badge>;
  return <Badge kind="faible">En cours</Badge>;
}

const SCHEDULE_LABEL = { paid: "Payé", partial: "Partiel", late: "En retard", upcoming: "À venir" };

function CreditDetail({ credit, business, onChange, onClose }) {
  const toast = useToast();
  const { auth } = useAuth();
  const isOwner = auth.user.role === "owner";
  const next = credit.next_due?.amount;
  const [amount, setAmount] = useState(next ? String(next) : "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [payId, setPayId] = useState(newId);
  const [error, setError] = useState(null);
  const wa = whatsappLink(credit, business);

  async function pay() {
    const value = parseNumber(amount);
    if (!(value > 0)) { setError("Indique le montant payé."); return; }
    setSaving(true);
    setError(null);
    try {
      // Même identifiant tant que l'envoi n'a pas réussi : un double clic n'enregistre qu'un seul paiement.
      const updated = await api.post(`/credits/${credit.id}/payments`, { amount: value, note: note.trim() || null, client_payment_id: payId });
      onChange(updated);
      setPayId(newId());
      setNote("");
      setAmount(updated.next_due ? String(updated.next_due.amount) : "");
      toast.push(updated.status === "paid" ? "Crédit soldé. Bravo !" : "Paiement enregistré.", "success");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="credit-detail">
      <div className="credit-info">
        <div><span>Client</span><b>{credit.customer_name}</b></div>
        <div><span>Statut</span><StatusBadge credit={credit} /></div>
        <div><span>Pièce d'identité</span><b className="mono">{credit.customer_id_number}</b></div>
        <div><span>Téléphone</span><b>{credit.customer_phone || "—"}</b></div>
        <div><span>Vente</span><b className="mono">{credit.sale_number}</b></div>
        <div><span>Date</span><b>{formatDateTime(credit.created_at)}</b></div>
      </div>

      <div className="credit-numbers">
        <div><span>Total à rembourser</span><b className="num">{fc(credit.total_due)}</b></div>
        <div><span>Déjà payé (acompte compris)</span><b className="num">{fc(credit.paid_total)}</b></div>
        <div><span>Reste à payer</span><b className="num">{fc(credit.balance)}</b></div>
        <div><span>{credit.is_overdue ? "En retard" : "Prochain versement"}</span>
          <b className="num">{credit.is_overdue ? fc(credit.overdue_amount) : credit.next_due ? fc(credit.next_due.amount) : "—"}</b>
          {!credit.is_overdue && credit.next_due && <small className="muted">le {fmtDay(credit.next_due.due_date)}</small>}
        </div>
      </div>
      {credit.interest_amount > 0 && (
        <p className="muted">Articles {fc(credit.subtotal)} + intérêts ({String(credit.interest_percent).replace(".", ",")} %) {fc(credit.interest_amount)}.</p>
      )}

      {credit.status === "open" && (
        <div className="credit-pay">
          <strong>Enregistrer un paiement</strong>
          <div className="credit-pay-row">
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Montant payé" aria-label="Montant payé" />
            <Button loading={saving} onClick={pay}>Encaisser</Button>
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (facultatif)" maxLength={200} aria-label="Note" />
          {error && <div className="credit-error" role="alert">{error}</div>}
        </div>
      )}

      <div>
        <h3>Calendrier · {credit.installments_count} versement{credit.installments_count > 1 ? "s" : ""} {frequencyLabel(credit.frequency)}</h3>
        <div className="credit-schedule">
          {credit.schedule.map((r) => (
            <div key={r.n} className={cx("credit-sched-row", r.status === "late" && "late", r.status === "paid" && "paid")}>
              <span className="n">{r.n}</span>
              <span>{fmtDay(r.due_date)}</span>
              <b className="num">{fc(r.amount)}</b>
              <span>{SCHEDULE_LABEL[r.status]}{r.status === "partial" ? ` (${fc(r.paid)})` : ""}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3>Paiements reçus</h3>
        <div className="credit-history">
          <div className="credit-history-row">
            <div>Acompte à la vente<small>{formatDateTime(credit.created_at)} · {credit.cashier_name || "—"}</small></div>
            <b className="num">{fc(credit.down_payment)}</b>
          </div>
          {credit.payments.map((p) => (
            <div key={p.id} className="credit-history-row">
              <div>Paiement<small>{formatDateTime(p.created_at)} · {p.cashier_name || "—"}{p.note ? ` · ${p.note}` : ""}</small></div>
              <b className="num">{fc(p.amount)}</b>
            </div>
          ))}
        </div>
      </div>

      {isOwner && credit.limit_override && (
        <p className="credit-warn">Limite de dette dépassée, validée par {credit.limit_override.authorized_by_name || "le propriétaire"} (dette après ce crédit : {fc(credit.limit_override.new_debt)}).</p>
      )}

      <div className="credit-actions">
        {credit.status === "open" && wa && (
          <a className="btn btn-soft" href={wa} target="_blank" rel="noopener noreferrer"><MessageCircle size={18} /><span>Relancer sur WhatsApp</span></a>
        )}
        {credit.customer_phone && <a className="btn btn-white" href={`tel:${credit.customer_phone}`}><Phone size={18} /><span>Appeler</span></a>}
        <Button kind="soft" onClick={onClose}>Fermer</Button>
      </div>
    </div>
  );
}

export default function Credits() {
  const { auth } = useAuth();
  const isOwner = auth.user.role === "owner";
  const toast = useToast();
  const { state } = useRouter();
  const [filter, setFilter] = useState(state?.filter || "open");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [selected, setSelected] = useState(null);
  const [simulator, setSimulator] = useState(false);

  // Recherche : on attend une courte pause dans la frappe avant d'interroger le serveur.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    try {
      const [list, sum] = await Promise.all([
        api.get("/credits", { query: { status: filter, q: search, page, page_size: PAGE_SIZE } }),
        isOwner ? api.get("/credits/summary") : Promise.resolve(null),
      ]);
      setData(list);
      if (sum) setSummary(sum);
    } catch (e) {
      toast.push(errorText(e), "error");
      setData((d) => d || { items: [], total: 0 });
    }
  }, [filter, search, page, isOwner, toast]);

  useEffect(() => { load(); }, [load]);

  function changed(updated) {
    setSelected(updated);
    setData((d) => d && { ...d, items: d.items.map((i) => (i.id === updated.id ? updated : i)) });
    load();
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const stats = summary && (
    <div className="credit-stats">
      <div className="stat-card"><span>Les clients nous doivent</span><b className="num">{fc(summary.outstanding)}</b><small>{summary.open_count} dossier{summary.open_count > 1 ? "s" : ""} en cours</small></div>
      <div className={cx("stat-card", summary.late_count > 0 && "warn")}><span>En retard</span><b className="num">{fc(summary.overdue_amount)}</b><small>{summary.late_count} client{summary.late_count > 1 ? "s" : ""}</small></div>
      <div className="stat-card"><span>À payer sous 7 jours</span><b className="num">{fc(summary.due_week_amount)}</b><small>{summary.due_week_count} dossier{summary.due_week_count > 1 ? "s" : ""}</small></div>
      <div className="stat-card"><span>Récupéré ce mois-ci</span><b className="num">{fc(summary.collected_month)}</b><small>remboursements reçus</small></div>
    </div>
  );

  const list = !data ? <Spinner /> : !data.items.length ? (
    <Empty icon={Wallet} title={search ? "Aucun dossier trouvé" : filter === "late" ? "Aucun client en retard" : "Aucun crédit ici"}
      text={search ? "Essaie un autre nom ou numéro." : "Les ventes à crédit apparaîtront ici."} />
  ) : (
    <div className="rows">
      {data.items.map((c) => (
        <button key={c.id} type="button" className="row" onClick={() => setSelected(c)}>
          <div className="row-main">
            <strong>{c.customer_name}</strong>
            <span>
              <span className="mono">{c.sale_number}</span>
              {c.status === "open" && c.next_due && <span>· prochain {fmtDay(c.next_due.due_date)}</span>}
            </span>
          </div>
          <div className="row-end">
            <b className="num">{fc(c.balance)}</b>
            <StatusBadge credit={c} />
          </div>
        </button>
      ))}
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

  return (
    <div className="page">
      <PageHeader title="Crédits" sub="Suivi des clients qui paient en plusieurs fois"
        actions={<Button kind="soft" icon={Calculator} onClick={() => setSimulator(true)}>Simulateur</Button>} />
      {stats}
      <div className="credit-toolbar">
        <div className="chips" role="tablist">
          {FILTERS.map((f) => (
            <button key={f.code} type="button" role="tab" aria-selected={filter === f.code} className={cx("chip", filter === f.code && "on")} onClick={() => { setFilter(f.code); setPage(1); }}>{f.label}</button>
          ))}
        </div>
        <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
          <Search size={18} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, téléphone ou n° de vente" aria-label="Rechercher un dossier" />
          {q && <button type="button" aria-label="Effacer" onClick={() => setQ("")}><X size={16} /></button>}
        </form>
      </div>
      {list}
      {pager}
      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title={selected ? `Dossier de ${selected.customer_name}` : ""} wide>
        {selected && <CreditDetail credit={selected} business={auth.business} onChange={changed} onClose={() => setSelected(null)} />}
      </Modal>
      <CreditSimulator open={simulator} onClose={() => setSimulator(false)} />
    </div>
  );
}
