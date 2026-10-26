import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, FileText, Pencil, Plus, Repeat, ScanLine, Search, Smartphone, Trash2, WifiOff, X } from "lucide-react";
import { api, openBlob } from "../lib/api";
import { fc, parseNumber } from "../lib/format";
import { PAYMENT_METHODS } from "../lib/labels";
import { creditSettings, frequencyLabel, fmtDay, previewCredit } from "../lib/credit";
import { beepError, beepOk, unlockAudio } from "../lib/feedback";
import { newId } from "../lib/ids";
import { useRouter } from "../lib/router";
import { useIsDesktop } from "../lib/useMedia";
import { cancelSale } from "../lib/cancelSale";
import { useAuth } from "../state/auth";
import { useCart, useProducts } from "../state/data";
import { useLive } from "../state/live";
import { errorText, useToast } from "../state/toast";
import { Button, Segmented, Stepper, Thumb, cx } from "../components/ui";
import CameraScanner from "../components/CameraScanner";
import Receipt from "../components/Receipt";
import { useMotifFlow } from "../components/useMotifFlow";
import CreditModal, { creditProblem, termsInputs } from "../components/CreditModal";
import OwnerAuthModal from "../components/OwnerAuthModal";
import "../credit.css";

const looksLikeCode = (s) => /^[A-Za-z0-9_\-]{4,}$/.test(s) && /\d|_/.test(s);

function ScannerIndicator() {
  const { status, scannerConnected, elsewhere } = useLive();
  let tone = "grey";
  let label = "Scanner déconnecté";
  if (elsewhere) label = "Caisse ouverte dans un autre onglet";
  else if (status === "reconnecting" || status === "connecting") { tone = "amber"; label = "Reconnexion…"; }
  else if (status === "offline") label = "Hors ligne";
  else if (status === "connected" && scannerConnected) { tone = "green"; label = "Scanner connecté"; }
  return (
    <div className={`scan-ind scan-ind-${tone}`} role="status">
      <span className="scan-ind-icon"><Smartphone size={16} /></span>
      <span className="scan-ind-dot" />
      {label}
    </div>
  );
}

function CartLine({ line }) {
  const { setQty, remove } = useCart();
  const p = line.product;
  return (
    <div className="cart-line">
      <Thumb name={p.name} size={46} />
      <div className="cart-line-main">
        <strong>{p.name}</strong>
        <span className="num">{fc(p.sale_price)}</span>
      </div>
      <Stepper value={line.qty} onChange={(q) => setQty(p.id, q)} />
      <button type="button" className="trash" aria-label={`Retirer ${p.name}`} onClick={() => remove(p.id)}><Trash2 size={19} /></button>
    </div>
  );
}

export default function Caisse() {
  const desktop = useIsDesktop();
  const { auth, switchMode } = useAuth();
  const { products, findByCode, loading: productsLoading, reload } = useProducts();
  const cart = useCart();
  const live = useLive();
  const toast = useToast();
  const { navigate } = useRouter();
  const motif = useMotifFlow();

  const [query, setQuery] = useState("");
  const [camera, setCamera] = useState(false);
  const [camFeedback, setCamFeedback] = useState(null);
  const [localUnknown, setLocalUnknown] = useState(null);
  const [method, setMethod] = useState("cash");
  const [received, setReceived] = useState("");
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState(null); // {network:boolean, text}
  const [sale, setSale] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [creditForm, setCreditForm] = useState(null); // saisie du formulaire de crédit (le serveur recalcule tout à la validation)
  const [creditOpen, setCreditOpen] = useState(false);
  const [ownerAuth, setOwnerAuth] = useState(null); // { info, error } : limite de dette dépassée, mot de passe du propriétaire demandé
  const searchRef = useRef(null);

  const credit = creditSettings(auth.business);
  const methods = credit.credit_enabled ? PAYMENT_METHODS : PAYMENT_METHODS.filter((m) => m.code !== "credit");
  // Aperçu recalculé avec le panier ACTUEL : si le caissier ajoute un article après avoir rempli le formulaire, tout suit.
  const creditPreview = useMemo(
    () => (method === "credit" && creditForm ? previewCredit(cart.total, credit, termsInputs(creditForm.terms), auth.business?.timezone) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [method, creditForm, cart.total, auth.business],
  );
  const creditIssue = method === "credit" ? (creditForm && creditPreview ? creditProblem(creditForm, creditPreview) : "Remplis le formulaire du crédit.") : null;

  const unknown = localUnknown || live.unknownCode;
  const clearUnknown = () => { setLocalUnknown(null); live.setUnknownCode(null); };

  // Un code (caméra, lecteur USB ou saisie) : quantité +1 si déjà dans le panier.
  const handleCode = useCallback(async (code) => {
    try {
      const p = await findByCode(code);
      if (p) {
        cart.add(p, code);
        clearUnknown();
        setCamFeedback({ ok: true, text: p.name, at: Date.now() });
        beepOk();
      } else {
        setLocalUnknown({ code, at: Date.now() });
        setCamFeedback({ ok: false, text: "Code inconnu", code, at: Date.now() });
        beepError();
      }
    } catch (e) {
      setCamFeedback({ ok: false, text: errorText(e), at: Date.now() });
      beepError();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findByCode, cart.add]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inStock = products.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.code || "").toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q));
    // Téléphone : une ligne de 4 produits pour garder le panier visible ; « Voir plus » pour en afficher davantage.
    const limit = desktop ? 12 : q || showAll ? 12 : 4;
    return inStock.slice(0, limit);
  }, [products, query, desktop, showAll]);

  function onSearchSubmit(e) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const exact = products.find((p) => p.code === q || p.qr_code === q);
    if (exact || looksLikeCode(q)) { handleCode(q); setQuery(""); return; }
    if (results.length === 1) { cart.add(results[0]); setQuery(""); }
  }

  // Lecteur de codes-barres USB (clavier) sur PC : la recherche garde le focus.
  useEffect(() => { if (desktop && !sale) searchRef.current?.focus(); }, [desktop, sale]);

  const receivedNum = parseNumber(received);
  const change = method === "cash" && Number.isFinite(receivedNum) ? receivedNum - cart.total : null;

  async function pay(ownerPassword) {
    if (!cart.lines.length || paying || cart.attempt?.uncertain) return;
    if (method === "cash" && Number.isFinite(receivedNum) && receivedNum < cart.total) {
      setPayError({ text: "Le montant reçu est inférieur au total." });
      return;
    }
    if (method === "credit" && creditIssue) {
      if (!creditForm) setCreditOpen(true);
      else setPayError({ text: creditIssue });
      return;
    }
    // Un identifiant par tentative : créé une fois au clic, gardé avec le panier, renvoyé tel quel.
    const attempt = cart.attempt ?? { id: newId(), uncertain: false };
    cart.setAttempt(attempt);
    setPaying(true);
    setPayError(null);
    try {
      const body = {
        client_sale_id: attempt.id,
        items: cart.lines.map((l) => ({ product_id: l.product.id, quantity: l.qty, ...(l.code ? { scanned_code: l.code } : {}) })),
        payment_method: method,
        ...(method === "cash" && Number.isFinite(receivedNum) ? { amount_received: receivedNum } : {}),
        ...(method === "credit" ? {
          credit: {
            customer_name: creditForm.name.trim(),
            customer_id_number: creditForm.idNumber.trim(),
            customer_phone: creditForm.phone.trim(),
            frequency: creditForm.terms.frequency,
            installment_amount: creditPreview.installment,
            down_payment: creditPreview.down,
            expected_total_due: creditPreview.totalDue,
            ...(ownerPassword ? { owner_password: ownerPassword } : {}),
          },
        } : {}),
      };
      const created = await api.post("/sales", body);
      cart.clear();
      setReceived("");
      setCreditForm(null);
      setOwnerAuth(null);
      if (method === "credit") setMethod("cash");
      setSale(created);
      reload(); // stocks à jour
    } catch (e) {
      if (e.status === 0) {
        // Coupure pendant l'envoi : on ne sait pas si la vente est passée. Aucun renvoi, ni automatique ni manuel.
        cart.setAttempt({ ...attempt, uncertain: true });
      } else if (e.code === "CREDIT_LIMIT") {
        setOwnerAuth({ info: e.data, error: null }); // le propriétaire doit valider avec son mot de passe
      } else if (e.code === "OWNER_PASSWORD_INVALID") {
        setOwnerAuth((a) => ({ info: a?.info || null, error: e.detail }));
      } else {
        setOwnerAuth(null);
        setPayError({ text: errorText(e) });
      }
    } finally {
      setPaying(false);
    }
  }

  async function changeMode() {
    setSwitching(true);
    try {
      await switchMode("scanner");
      navigate("/scanner", { replace: true });
    } catch (e) {
      toast.push(errorText(e), "error");
      setSwitching(false);
    }
  }

  function askCancel() {
    motif.start({
      title: "Pourquoi annuler cette vente ?",
      subtitle: `${sale.number} · ${fc(sale.total)}`,
      run: (m) => cancelSale(sale.id, m),
      onDone: (s) => { setSale(s); reload(); toast.push("Vente annulée.", "success"); },
    });
  }

  const openCamera = () => { unlockAudio(); setCamFeedback(null); setCamera(true); };

  if (sale) {
    return (
      <div className="receipt-screen">
        <div className="receipt-done">
          <span className="receipt-check">✓</span>
          <div>
            <strong>{sale.status === "cancelled" ? "Vente annulée" : "Vente enregistrée"}</strong>
            <span>Reçu {sale.number}</span>
          </div>
        </div>
        <Receipt sale={sale} business={auth.business} />
        <div className="receipt-actions">
          <Button kind="white" icon={FileText} onClick={() => openBlob("GET", `/sales/${sale.id}/invoice`).catch((e) => toast.push(errorText(e), "error"))}>Facture PDF</Button>
          {sale.status === "completed" && (auth.user.role === "owner" || sale.payment_method !== "credit") && <Button kind="danger" icon={Ban} onClick={askCancel}>Annuler la vente</Button>}
          <Button icon={Plus} className="grow" onClick={() => setSale(null)}>Nouvelle vente</Button>
        </div>
        {motif.modal}
      </div>
    );
  }

  const unknownBanner = unknown && (
    <div className="unknown" role="alert">
      <span className="unknown-x"><X size={18} strokeWidth={3} /></span>
      <div className="unknown-text"><strong>Code inconnu</strong><span className="mono">{unknown.code}</span></div>
      <Button kind="ghost" icon={Plus} size="sm" onClick={() => navigate("/produits/nouveau", { state: { code: unknown.code, from: "caisse" } })}>Ajouter ce produit</Button>
      <button type="button" className="unknown-close" aria-label="Fermer" onClick={clearUnknown}><X size={16} /></button>
    </div>
  );

  const search = (
    <form className="search" onSubmit={onSearchSubmit} role="search">
      <Search size={18} />
      <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nom ou code du produit" aria-label="Rechercher un produit par nom ou code" enterKeyHint="search" />
      {query && <button type="button" aria-label="Effacer" onClick={() => setQuery("")}><X size={16} /></button>}
    </form>
  );

  const grid = (
    <>
      <div className="section-row">
        <div className="section-label">{query ? "Résultats" : "Accès rapide"}</div>
        {!desktop && !query && products.length > 4 && (
          <button type="button" className="link" onClick={() => setShowAll((v) => !v)}>{showAll ? "Voir moins" : "Voir plus"}</button>
        )}
      </div>
      {results.length ? (
        <div className="quick-grid">
          {results.map((p) => (
            <button key={p.id} type="button" className={cx("quick", Number(p.quantity) <= 0 && "quick-out")} onClick={() => cart.add(p)}>
              <Thumb name={p.name} size={desktop ? 40 : 34} />
              <strong>{p.name}</strong>
              <span className="num">{fc(p.sale_price)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted small-pad">{productsLoading ? "Chargement des produits…" : query ? "Aucun produit trouvé." : "Aucun produit pour l'instant."}</p>
      )}
    </>
  );

  const uncertain = Boolean(cart.attempt?.uncertain);
  const isOwner = auth.user.role === "owner";
  const payment = (
    <div className="pay-box">
      <Segmented className={methods.length > 3 ? "segmented-4" : ""} options={methods} value={method} onChange={(m) => { setMethod(m); setPayError(null); if (m === "credit") setCreditOpen(true); }} />
      {method === "cash" && (
        <div className="cash-row">
          <input inputMode="decimal" placeholder="Montant reçu (facultatif)" value={received} onChange={(e) => setReceived(e.target.value)} aria-label="Montant reçu" />
          {change !== null && change >= 0 && <span className="change">Monnaie : <b className="num">{fc(change)}</b></span>}
        </div>
      )}
      {method === "credit" && (
        <div className="credit-box">
          {creditForm && creditPreview && !creditPreview.error && !creditPreview.incomplete ? (
            <>
              <div className="credit-box-head">
                <strong>{creditForm.name.trim() || "Client"}</strong>
                <Button kind="ghost" size="sm" icon={Pencil} onClick={() => setCreditOpen(true)}>Modifier</Button>
              </div>
              {creditPreview.interest > 0 && (
                <div className="credit-line"><span>dont intérêts ({String(creditPreview.pct).replace(".", ",")} %)</span><b className="num">{fc(creditPreview.interest)}</b></div>
              )}
              <div className="credit-line"><span>Acompte maintenant</span><b className="num">{fc(creditPreview.down)}</b></div>
              <div className="credit-line big"><span>Reste à payer</span><b className="num">{fc(creditPreview.balance)}</b></div>
              <div className="credit-terms">
                {creditPreview.count} versement{creditPreview.count > 1 ? "s" : ""} de {fc(creditPreview.installment)} {frequencyLabel(creditForm.terms.frequency)} · premier le {fmtDay(creditPreview.first)}
              </div>
            </>
          ) : (
            <>
              <div className="credit-box-head">
                <strong>Vente à crédit</strong>
                <Button kind="soft" size="sm" onClick={() => setCreditOpen(true)}>{creditForm ? "Corriger le formulaire" : "Remplir le formulaire"}</Button>
              </div>
              {creditForm && creditIssue && <div className="credit-error" role="alert">{creditIssue}</div>}
            </>
          )}
        </div>
      )}
      {method === "credit" && creditPreview && !creditPreview.error ? (
        <div className="total-row"><span>Total à rembourser</span><b className="num">{fc(creditPreview.totalDue)}</b></div>
      ) : (
        <div className="total-row"><span>{method === "credit" ? "Total des articles" : "Total"}</span><b className="num">{fc(cart.total)}</b></div>
      )}
      {payError && (
        <div className="pay-error" role="alert">
          <Ban size={18} />
          <div><strong>{payError.text}</strong></div>
        </div>
      )}
      {uncertain ? (
        <>
          <div className="pay-error pay-error-net" role="alert">
            <WifiOff size={18} />
            <div>
              <strong>La vente n'a peut-être pas été enregistrée. Vérifie dans Ventes avant de réessayer.</strong>
              <span>Ton panier est gardé.</span>
            </div>
          </div>
          <div className="uncertain-actions">
            <Button kind="soft" onClick={() => navigate(isOwner ? "/ventes" : "/mes-ventes")}>{isOwner ? "Voir les ventes" : "Voir mes ventes"}</Button>
            <Button kind="ghost" onClick={() => { cart.clear(); setPayError(null); }}>Vider le panier</Button>
          </div>
        </>
      ) : (
        <Button className="btn-block btn-xl" loading={paying} disabled={!cart.lines.length} onClick={() => pay()}>{method === "credit" ? "Valider le crédit" : "Payer"}</Button>
      )}
    </div>
  );

  const cartList = cart.lines.length ? (
    <div className="cart-list">{cart.lines.map((l) => <CartLine key={l.product.id} line={l} />)}</div>
  ) : (
    <div className="cart-empty">Scanne un produit ou touche-le dans l'accès rapide.</div>
  );

  const creditModals = (
    <>
      <CreditModal
        open={creditOpen}
        onClose={() => { setCreditOpen(false); if (!creditForm) setMethod("cash"); }}
        subtotal={cart.total}
        initial={creditForm}
        onSave={(form) => { setCreditForm(form); setCreditOpen(false); setPayError(null); }}
      />
      <OwnerAuthModal
        open={Boolean(ownerAuth)}
        info={ownerAuth?.info}
        error={ownerAuth?.error}
        loading={paying}
        onClose={() => setOwnerAuth(null)}
        onConfirm={(password) => pay(password)}
      />
    </>
  );

  const cameraOverlay = camera && (
    <CameraScanner
      title="Scanner un produit"
      onClose={() => setCamera(false)}
      onCode={handleCode}
      feedback={camFeedback && (
        <div key={camFeedback.at} className={cx("cam-feedback", camFeedback.ok ? "ok" : "bad")}>
          {camFeedback.ok ? `Ajouté : ${camFeedback.text}` : camFeedback.text}
          {!camFeedback.ok && camFeedback.code && <span className="mono"> {camFeedback.code}</span>}
          <span className="cam-count">{cart.count} article{cart.count > 1 ? "s" : ""} · {fc(cart.total)}</span>
        </div>
      )}
    />
  );

  if (desktop) {
    return (
      <div className="caisse-desk">
        <section className="caisse-left">
          <div className="caisse-head">
            <div><span className="muted">Caisse de {auth.user.name}</span><h1>Nouvelle vente</h1></div>
            <ScannerIndicator />
          </div>
          {search}
          {unknownBanner}
          {grid}
        </section>
        <aside className="caisse-cart card">
          <div className="cart-head"><h2>Panier</h2><span className="muted">{cart.count} article{cart.count > 1 ? "s" : ""}</span></div>
          {cartList}
          {payment}
        </aside>
        {cameraOverlay}
        {creditModals}
      </div>
    );
  }

  return (
    <div className="caisse-phone">
      <div className="caisse-phone-top">
        <div className="caisse-phone-head">
          <span className="muted">Caisse de {auth.user.name}</span>
          <Button kind="soft" size="sm" icon={Repeat} loading={switching} onClick={changeMode}>Changer de mode</Button>
        </div>
        <h1>Nouvelle vente</h1>
        <button type="button" className="scan-big" onClick={openCamera}>
          <span className="scan-big-icon"><ScanLine size={28} /><span className="laser" /></span>
          Scanner
        </button>
        {search}
        {unknownBanner}
        {grid}
        <div className="cart-head"><span className="section-label">Panier</span><span className="muted">{cart.count} article{cart.count > 1 ? "s" : ""}</span></div>
        {cartList}
      </div>
      <div className="caisse-phone-pay">{payment}</div>
      {cameraOverlay}
      {creditModals}
    </div>
  );
}
