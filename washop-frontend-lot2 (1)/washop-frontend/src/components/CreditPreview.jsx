import { fc } from "../lib/format";
import { fmtDay, frequencyLabel } from "../lib/credit";
import "../credit.css";

// Récapitulatif d'un crédit en cours de saisie : total, reste, nombre de versements, calendrier.
// `preview` vient de previewCredit() (lib/credit.js).
export function CreditTotals({ preview: p }) {
  return (
    <div className="credit-sum">
      <div className="credit-line"><span>Total des articles</span><b className="num">{fc(p.subtotal)}</b></div>
      {p.pct > 0 && <div className="credit-line"><span>Intérêts ({String(p.pct).replace(".", ",")} %)</span><b className="num">+ {fc(p.interest)}</b></div>}
      <div className="credit-line total"><span>Total à rembourser</span><b className="num">{fc(p.totalDue)}</b></div>
    </div>
  );
}

export default function CreditPreview({ preview, maxRows = 6, hideTotals = false }) {
  const p = preview;
  return (
    <>
      {!hideTotals && <CreditTotals preview={p} />}
      {p.error && <div className="credit-error" role="alert">{p.error}</div>}
      {!p.error && p.count > 0 && (
        <>
          <div className="credit-sum">
            <div className="credit-line"><span>Acompte payé maintenant</span><b className="num">{fc(p.down)}</b></div>
            <div className="credit-line big"><span>Reste à payer</span><b className="num">{fc(p.balance)}</b></div>
            <div className="credit-terms">
              {p.count} versement{p.count > 1 ? "s" : ""} de {fc(p.installment)} {frequencyLabel(p.frequency)}
              {p.count > 1 && p.balance !== p.installment * p.count ? " (le dernier peut être plus petit)" : ""}
              <br />Premier le {fmtDay(p.first)} · dernier le {fmtDay(p.last)}
            </div>
          </div>
          <div className="credit-schedule" aria-label="Calendrier des versements">
            {p.schedule.slice(0, maxRows).map((r) => (
              <div key={r.n} className="credit-sched-row">
                <span className="n">{r.n}</span>
                <span>{fmtDay(r.due_date)}</span>
                <b className="num">{fc(r.amount)}</b>
                <span />
              </div>
            ))}
            {p.schedule.length > maxRows && <div className="credit-sched-more">… et {p.schedule.length - maxRows} autre{p.schedule.length - maxRows > 1 ? "s" : ""} versement{p.schedule.length - maxRows > 1 ? "s" : ""}</div>}
          </div>
        </>
      )}
    </>
  );
}
