// Stock intelligent : fonds de réappro (séparé du bénéfice) et produits gagnants.
// Le fonds et le bénéfice sont réservés au propriétaire ; le caissier ne voit que les quantités vendues.
import { useEffect, useState } from "react";
import { PiggyBank, Moon, RotateCcw, SlidersHorizontal, TrendingUp, Trophy } from "lucide-react";
import { api } from "../lib/api";
import { fc, formatDateTime, parseNumber, qty } from "../lib/format";
import { MOTIF_NOTE_MIN } from "../lib/labels";
import { errorText, useToast } from "../state/toast";
import { Button, Field, Modal, Segmented, Thumb, cx } from "./ui";
import "../stock-smart.css";

const day = (value) => formatDateTime(value).slice(0, 10);

// Démarrage, remise à zéro et ajustement du fonds.
function FundModal({ mode, onClose, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [sign, setSign] = useState("add");
  const [motif, setMotif] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const n = parseNumber(amount);
  const adjust = mode === "adjust";
  const motifRequired = adjust || mode === "reset";
  const validAmount = adjust ? Number.isFinite(n) && n > 0 : amount === "" || (Number.isFinite(n) && n >= 0);
  const validMotif = !motifRequired || motif.trim().length >= MOTIF_NOTE_MIN;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      if (adjust) {
        await api.post("/stock/fund/adjustments", { amount: sign === "add" ? n : -n, motif: motif.trim() });
        toast.push("Fonds ajusté.", "success");
      } else {
        await api.post("/stock/fund/start", { opening_amount: amount === "" ? 0 : n, motif: motif.trim() || undefined });
        toast.push(mode === "reset" ? "Fonds remis à zéro." : "Suivi du fonds démarré.", "success");
      }
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const title = adjust ? "Ajuster le fonds" : "Remettre le fonds à zéro";
  return (
    <Modal open onClose={onClose} title={title} footer={<Button className="btn-block btn-lg" loading={saving} disabled={!validAmount || !validMotif} onClick={submit}>{adjust ? "Enregistrer l'ajustement" : "Remettre à zéro"}</Button>}>
      {adjust ? (
        <>
          <p className="muted ssm-modal-text">Tu as pris de l'argent dans le fonds, ou tu en as ajouté ? Note-le pour que le chiffre reste juste.</p>
          <Segmented options={[{ code: "add", label: "J'ajoute" }, { code: "remove", label: "Je retire" }]} value={sign} onChange={setSign} />
          <Field label="Montant (FC)" className="ssm-field"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
        </>
      ) : (
        <>
          <p className="muted ssm-modal-text">Le fonds repart de zéro à partir d'aujourd'hui. Les anciennes ventes ne comptent plus.</p>
          <Field label="Argent déjà disponible pour racheter (facultatif)" className="ssm-field"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" /></Field>
        </>
      )}
      {motifRequired && (
        <Field label="Pourquoi ?" hint={`${MOTIF_NOTE_MIN} caractères minimum`} className="ssm-field">
          <textarea rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} maxLength={255} />
        </Field>
      )}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
    </Modal>
  );
}

export function FundPanel({ rev, onChanged }) {
  const toast = useToast();
  const [fund, setFund] = useState(null);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState("");
  const [starting, setStarting] = useState(false);
  const [modal, setModal] = useState(null); // "adjust" | "reset"

  useEffect(() => {
    let alive = true;
    api.get("/stock/fund").then((d) => { if (alive) { setFund(d); setFailed(false); } }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [rev]);

  async function start() {
    const n = parseNumber(opening);
    if (opening !== "" && (!Number.isFinite(n) || n < 0)) { toast.push("Montant invalide.", "error"); return; }
    setStarting(true);
    try {
      await api.post("/stock/fund/start", { opening_amount: opening === "" ? 0 : n });
      toast.push("Suivi du fonds démarré.", "success");
      onChanged();
    } catch (e) {
      toast.push(errorText(e), "error");
    } finally {
      setStarting(false);
    }
  }

  if (failed) return null;
  if (!fund) return <div className="ssm-card muted">Chargement du fonds…</div>;

  if (!fund.started) {
    return (
      <section className="ssm-card ssm-start">
        <span className="ssm-label"><PiggyBank size={16} /> Fonds de réappro</span>
        <strong className="ssm-start-title">Sépare l'argent du stock de ton bénéfice</strong>
        <p className="muted ssm-modal-text">Washop calcule à partir de tes ventes combien tu peux remettre dans le stock, sans toucher à ce qui est à toi. Le suivi commence aujourd'hui.</p>
        <div className="ssm-start-row">
          <Field label="Argent déjà disponible pour racheter (facultatif)"><input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" /></Field>
          <Button loading={starting} onClick={start}>Commencer le suivi</Button>
        </div>
      </section>
    );
  }

  const negative = fund.reappro_budget < 0;
  return (
    <section className="ssm-fund-wrap">
      <div className="ssm-fund">
        <div className="ssm-card ssm-card-fund">
          <span className="ssm-label"><PiggyBank size={16} /> Fonds de réappro</span>
          <b className={cx("ssm-big num", negative && "red")}>{fc(fund.reappro_budget)}</b>
          <span className="ssm-sub">{negative ? "Tu as racheté plus que ce que tes ventes ont rapporté." : "L'argent des produits vendus, à remettre dans le stock."}</span>
        </div>
        <div className="ssm-card">
          <span className="ssm-label"><TrendingUp size={16} /> Ton bénéfice</span>
          <b className="ssm-big num">{fc(fund.profit_collected)}</b>
          <span className="ssm-sub">À toi. Il n'est pas compté dans le fonds.</span>
        </div>
      </div>
      <div className="ssm-fund-foot">
        <span className="muted">
          Depuis le {day(fund.since)}
          {fund.credit_outstanding > 0 && ` · ${fc(fund.credit_outstanding)} de crédits à encaisser (pas encore comptés)`}
        </span>
        <span className="ssm-links">
          <button type="button" className="link" onClick={() => setModal("adjust")}><SlidersHorizontal size={14} /> Ajuster</button>
          <button type="button" className="link" onClick={() => setModal("reset")}><RotateCcw size={14} /> Remettre à zéro</button>
        </span>
      </div>
      <details className="ssm-details">
        <summary>Comment c'est calculé ?</summary>
        <dl>
          <div><dt>Argent de départ</dt><dd className="num">{fc(fund.opening_amount)}</dd></div>
          <div><dt>+ Coût d'achat des produits vendus et encaissés</dt><dd className="num">{fc(fund.cogs_collected)}</dd></div>
          <div><dt>− Réapprovisionnements</dt><dd className="num">{fc(fund.restocked_cost)}</dd></div>
          <div><dt>± Ajustements</dt><dd className="num">{fc(fund.adjustments)}</dd></div>
          <div className="ssm-total"><dt>= Fonds de réappro</dt><dd className="num">{fc(fund.reappro_budget)}</dd></div>
        </dl>
        <p className="muted">Une vente à crédit compte seulement pour la part déjà payée par le client. Une vente annulée ne compte pas.</p>
        {fund.entries.length > 0 && (
          <ul className="ssm-entries">
            {fund.entries.map((e) => (
              <li key={e.id}><span>{day(e.created_at)} · {e.motif}</span><b className={cx("num", e.amount < 0 && "red")}>{e.amount > 0 ? "+" : ""}{fc(e.amount)}</b></li>
            ))}
          </ul>
        )}
      </details>
      {modal && <FundModal mode={modal} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />}
    </section>
  );
}

const PERIODS = [{ code: 7, label: "7 jours" }, { code: 30, label: "30 jours" }];

export function WinnersPanel({ isOwner, rev }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    api.get("/stock/winners", { query: { days, limit: 5 } }).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData({ winners: [], dormant: [] }); });
    return () => { alive = false; };
  }, [days, rev]);

  const winners = data?.winners || [];
  const top = winners[0] ? (isOwner ? Math.max(1, winners[0].profit) : Math.max(1, winners[0].quantity_sold)) : 1;

  return (
    <section className="ssm-card">
      <div className="ssm-head">
        <div>
          <h2><Trophy size={16} /> Produits gagnants</h2>
          <span className="muted">{isOwner ? "Classés par bénéfice" : "Classés par quantité vendue"}</span>
        </div>
        <Segmented className="segmented-sm" options={PERIODS} value={days} onChange={setDays} />
      </div>
      {data === null ? <div className="muted">…</div> : !winners.length ? <p className="muted">Pas encore de ventes sur cette période.</p> : (
        <ol className="ssm-winners">
          {winners.map((w, i) => {
            const value = isOwner ? w.profit : w.quantity_sold;
            return (
              <li key={w.product_id}>
                <i className="ssm-meter" style={{ width: `${Math.max(4, (value / top) * 100)}%` }} />
                <span className="ssm-rank">{i + 1}</span>
                <Thumb name={w.name} size={34} />
                <span className="ssm-grow"><strong>{w.name}</strong><span className="muted">{qty(w.quantity_sold)} vendus</span></span>
                {isOwner && <b className="num">{fc(w.profit)}</b>}
              </li>
            );
          })}
        </ol>
      )}
      {isOwner && data?.dormant?.length > 0 && (
        <div className="ssm-dormant">
          <h3><Moon size={15} /> Ne bougent pas : évite de les racheter</h3>
          <ul>
            {data.dormant.map((d) => (
              <li key={d.product_id}><span>{d.name}</span><span className="muted num">{qty(d.quantity)} en stock · {fc(d.immobilized)} immobilisés</span></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
