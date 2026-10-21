// Tableau de bord : propriétaire uniquement. Pas de bannière, le contenu utile commence tout de suite.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ScanLine, TrendingDown, TrendingUp } from "lucide-react";
import { api } from "../lib/api";
import { addDays, fc, formatDayLong, formatTime, qty, todayIn } from "../lib/format";
import { useRouter } from "../lib/router";
import { useIsDesktop } from "../lib/useMedia";
import { useAuth } from "../state/auth";
import { errorText, useToast } from "../state/toast";
import { Button, SaleBadge, Thumb, cx } from "../components/ui";
import { PageHeader } from "../components/Layout";

const PERIODS = [{ code: 7, label: "7 jours" }, { code: 30, label: "30 jours" }];
const DAY_ABBR = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

function Chart({ days, period }) {
  const max = Math.max(1, ...days.map((d) => d.revenue));
  const bestIndex = days.reduce((bi, d, i) => (d.revenue > days[bi].revenue ? i : bi), 0);
  return (
    <div className={cx("chart", period === 30 && "chart-dense")}>
      {days.map((d, i) => {
        const date = new Date(`${d.date}T12:00:00Z`);
        const today = i === days.length - 1;
        const label = period === 7 ? DAY_ABBR[date.getUTCDay()] : (i % 5 === 4 || today ? String(date.getUTCDate()) : "");
        return (
          <div key={d.date} className="chart-col" title={`${d.date} : ${fc(d.revenue)}`}>
            <div className={cx("chart-bar", today && "today")} style={{ height: `${Math.max(2, (d.revenue / max) * 100)}%` }}>
              {(today || (i === bestIndex && d.revenue > 0 && period === 7)) && <span className="chart-tip num">{fc(d.revenue)}</span>}
            </div>
            <span className="chart-label">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const { auth } = useAuth();
  const { navigate } = useRouter();
  const desktop = useIsDesktop();
  const toast = useToast();
  const tz = auth.business?.timezone;
  const [period, setPeriod] = useState(7);
  const [summary, setSummary] = useState(null);
  const [soldToday, setSoldToday] = useState(null);
  const [lowStock, setLowStock] = useState(null);
  const [series, setSeries] = useState(null);
  const [top, setTop] = useState(null);
  const [recent, setRecent] = useState(null);

  useEffect(() => {
    const fail = (e) => toast.push(errorText(e), "error");
    api.get("/stats/summary", { query: { period: "today" } }).then(setSummary).catch(fail);
    // « Produits vendus » : somme des quantités vendues aujourd'hui (le résumé ne la donne pas).
    api.get("/stats/top-products", { query: { period: "today", limit: 100 } })
      .then((r) => setSoldToday(r.top_products.reduce((s, p) => s + p.quantity_sold, 0))).catch(fail);
    api.get("/alerts").then((r) => setLowStock(r.low_stock.length)).catch(fail);
    api.get("/sales", { query: { page_size: 5 } }).then((r) => setRecent(r.items)).catch(fail);
  }, [toast]);

  useEffect(() => {
    const to = todayIn(tz);
    const from = addDays(to, -(period - 1));
    setSeries(null);
    setTop(null);
    api.get("/stats/sales-by-day", { query: { from, to } }).then((rows) => {
      const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
      setSeries(Array.from({ length: period }, (_, i) => {
        const d = addDays(from, i);
        return { date: d, revenue: byDate[d]?.revenue || 0 };
      }));
    }).catch((e) => toast.push(errorText(e), "error"));
    api.get("/stats/top-products", { query: { period: "custom", from, to, limit: 5 } }).then((r) => setTop(r.top_products)).catch(() => setTop([]));
  }, [period, tz, toast]);

  const total = useMemo(() => (series ? series.reduce((s, d) => s + d.revenue, 0) : 0), [series]);
  const change = summary?.change_pct?.revenue;

  return (
    <div className="page">
      <PageHeader
        title={`Bonjour ${auth.user.name.split(" ")[0]}`}
        sub={`${formatDayLong()} · ${auth.business?.name || ""}`}
        actions={desktop && <Button icon={ScanLine} onClick={() => navigate("/caisse")}>Ouvrir la caisse</Button>}
      />
      <div className="dash-cards">
        <div className="hero-card">
          <span>Ventes du jour</span>
          <b className="num">{summary ? fc(summary.revenue) : "…"}</b>
          {change != null && (
            <em>{change >= 0 ? <TrendingUp size={15} /> : <TrendingDown size={15} />} {change >= 0 ? "+" : ""}{String(change).replace(".", ",")} % vs hier</em>
          )}
        </div>
        <div className="stat-card"><span>Nombre de ventes</span><b className="num">{summary ? qty(summary.sales_count) : "…"}</b></div>
        <div className="stat-card"><span>Produits vendus</span><b className="num">{soldToday != null ? qty(soldToday) : "…"}</b></div>
        <button type="button" className={cx("stat-card", "stat-warn")} onClick={() => navigate("/stock")}>
          <span><AlertTriangle size={15} /> Stock faible</span>
          <b className="num">{lowStock != null ? lowStock : "…"}</b>
        </button>
      </div>

      <div className="dash-grid">
        <section className="card">
          <div className="card-head">
            <h2>Évolution des ventes</h2>
            <div className="segmented segmented-sm">
              {PERIODS.map((p) => <button key={p.code} type="button" className={period === p.code ? "on" : ""} onClick={() => setPeriod(p.code)}>{p.label}</button>)}
            </div>
          </div>
          {series ? <><div className="muted chart-total">Total : <b className="num">{fc(total)}</b></div><Chart days={series} period={period} /></> : <div className="chart-skeleton" />}
        </section>
        <section className="card">
          <div className="card-head"><h2>Top produits</h2><span className="muted">{period} jours</span></div>
          {top === null ? <div className="muted">…</div> : !top.length ? <p className="muted">Aucune vente sur la période.</p> : (
            <ol className="top-list">
              {top.map((p) => (
                <li key={p.product_id}><Thumb name={p.name} size={34} /><span className="grow">{p.name}</span><span className="muted num">{qty(p.quantity_sold)} vendus</span></li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Dernières ventes</h2><button type="button" className="link" onClick={() => navigate("/ventes")}>Tout voir</button></div>
        {recent === null ? <div className="muted">…</div> : !recent.length ? <p className="muted">Aucune vente pour l'instant.</p> : (
          <div className="recent">
            {recent.map((s) => (
              <div key={s.id} className="recent-item">
                <div><strong>{s.cashier_name || "—"}</strong><span className="muted"><span className="mono">{s.number}</span> · {formatTime(s.created_at)}</span></div>
                <div className="recent-end"><b className="num">{fc(s.total)}</b><SaleBadge status={s.status} /></div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
