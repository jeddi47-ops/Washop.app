import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, Barcode, Boxes, Check, ChevronLeft, Plus, Printer, QrCode, ScanLine, ShoppingCart } from "lucide-react";
import { api, openBlob } from "../lib/api";
import { fc, parseNumber, qty } from "../lib/format";
import { useRouter } from "../lib/router";
import { useAuth } from "../state/auth";
import { useCart, useProducts } from "../state/data";
import { errorText, useToast } from "../state/toast";
import { Button, ConfirmModal, Field, Spinner, StockBadge, Thumb, cx } from "../components/ui";
import CameraScanner from "../components/CameraScanner";
import RestockModal from "../components/RestockModal";
import { useMotifFlow } from "../components/useMotifFlow";

const EMPTY = { name: "", category: "", sale_price: "", purchase_price: "", initial_quantity: "", unit: "pièce", low_stock_threshold: "", expiry_date: "", description: "" };

function toForm(p) {
  return {
    name: p.name || "",
    category: p.category || "",
    sale_price: p.sale_price != null ? String(p.sale_price).replace(".", ",") : "",
    purchase_price: p.purchase_price != null ? String(p.purchase_price).replace(".", ",") : "",
    unit: p.unit || "pièce",
    low_stock_threshold: p.low_stock_threshold != null ? String(p.low_stock_threshold).replace(".", ",") : "",
    expiry_date: p.expiry_date ? String(p.expiry_date).slice(0, 10) : "",
    description: p.description || "",
  };
}

function validate(f, { isOwner, creating }) {
  const e = {};
  if (!f.name.trim()) e.name = "Le nom est obligatoire.";
  const sp = parseNumber(f.sale_price);
  if (!Number.isFinite(sp) || sp < 0) e.sale_price = "Indique un prix de vente.";
  if (isOwner && f.purchase_price !== "") {
    const pp = parseNumber(f.purchase_price);
    if (!Number.isFinite(pp) || pp < 0) e.purchase_price = "Prix d'achat invalide.";
  }
  if (creating && f.initial_quantity !== "") {
    const q = parseNumber(f.initial_quantity);
    if (!Number.isFinite(q) || q < 0) e.initial_quantity = "Quantité invalide.";
  }
  if (f.low_stock_threshold !== "") {
    const t = parseNumber(f.low_stock_threshold);
    if (!Number.isFinite(t) || t < 0) e.low_stock_threshold = "Seuil invalide.";
  }
  if (!f.unit.trim()) e.unit = "L'unité est obligatoire.";
  return e;
}

function ProductFields({ form, setForm, errors, isOwner, creating }) {
  const { categories } = useProducts();
  const set = (k) => (ev) => setForm((f) => ({ ...f, [k]: ev.target.value }));
  return (
    <div className="form-grid">
      <Field label="Nom" error={errors.name} className="span-2"><input value={form.name} onChange={set("name")} maxLength={120} /></Field>
      <Field label="Catégorie">
        <input value={form.category} onChange={set("category")} list="categories" maxLength={60} />
        <datalist id="categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      </Field>
      <Field label="Unité" error={errors.unit}><input value={form.unit} onChange={set("unit")} maxLength={20} /></Field>
      <Field label="Prix de vente (FC)" error={errors.sale_price}><input inputMode="decimal" value={form.sale_price} onChange={set("sale_price")} /></Field>
      {/* Prix d'achat : jamais affiché ni envoyé pour un caissier */}
      {isOwner && <Field label="Prix d'achat (FC)" error={errors.purchase_price}><input inputMode="decimal" value={form.purchase_price} onChange={set("purchase_price")} /></Field>}
      {creating && <Field label="Quantité en stock" error={errors.initial_quantity}><input inputMode="decimal" value={form.initial_quantity} onChange={set("initial_quantity")} placeholder="0" /></Field>}
      <Field label="Seuil de stock faible" error={errors.low_stock_threshold} hint="Vide : seuil par défaut du commerce"><input inputMode="decimal" value={form.low_stock_threshold} onChange={set("low_stock_threshold")} /></Field>
      <Field label="Date de péremption"><input type="date" value={form.expiry_date} onChange={set("expiry_date")} /></Field>
      <Field label="Description" className="span-2"><textarea rows={2} value={form.description} onChange={set("description")} maxLength={500} /></Field>
    </div>
  );
}

function BackBar({ title, onBack }) {
  return (
    <div className="backbar">
      <button type="button" className="icon-btn" aria-label="Retour" onClick={onBack}><ChevronLeft size={20} /></button>
      <span>{title}</span>
    </div>
  );
}

function ExistsPanel({ productId, onRestock, onAgain }) {
  const { auth } = useAuth();
  const [p, setP] = useState(null);
  useEffect(() => { api.get(`/products/${productId}`).then(setP).catch(() => {}); }, [productId]);
  return (
    <div className="card exists" role="alert">
      <div className="exists-kicker"><AlertTriangle size={17} /> Code déjà enregistré</div>
      <h2>Ce produit existe déjà</h2>
      {p && (
        <div className="tile exists-product">
          <Thumb name={p.name} size={52} />
          <div><strong>{p.name}</strong><span className="muted">{qty(p.quantity)} en stock · {fc(p.sale_price)}</span></div>
          <StockBadge product={p} business={auth.business} />
        </div>
      )}
      <Button className="btn-block btn-lg" icon={Plus} onClick={onRestock}>Ajouter du stock</Button>
      <Button kind="soft" className="btn-block" onClick={onAgain}>Utiliser un autre code</Button>
    </div>
  );
}

function QrPreview({ productId }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let url;
    api.blob("GET", `/products/${productId}/qr`).then((b) => { url = URL.createObjectURL(b); setSrc(url); }).catch(() => {});
    return () => url && URL.revokeObjectURL(url);
  }, [productId]);
  return <div className="qr-box">{src ? <img src={src} alt="QR code du produit" /> : <QrCode size={64} />}</div>;
}

export function ProductNew() {
  const { isOwner } = useAuth();
  const { state, navigate } = useRouter();
  const { upsert, findByCode } = useProducts();
  const cart = useCart();
  const toast = useToast();
  const fromCaisse = state?.from === "caisse";
  const [step, setStep] = useState(state?.code ? "form" : "choose"); // choose | form | exists | done
  const [codeType, setCodeType] = useState(state?.code ? "barcode" : null);
  const [code, setCode] = useState(state?.code || "");
  const [typing, setTyping] = useState(false);
  const [camera, setCamera] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [existsId, setExistsId] = useState(null);
  const [created, setCreated] = useState(null);

  const back = () => (fromCaisse ? navigate("/caisse") : navigate("/produits"));

  async function applyBarcode(c) {
    const value = c.trim();
    if (!value) return;
    setCode(value);
    setCodeType("barcode");
    try {
      const existing = await findByCode(value);
      if (existing) { setExistsId(existing.id); setStep("exists"); return; }
    } catch { /* on laisse le backend trancher à l'enregistrement */ }
    setStep("form");
  }

  async function submit(e) {
    e.preventDefault();
    const errs = validate(form, { isOwner, creating: true });
    if (codeType === "barcode" && !code.trim()) errs.code = "Indique le numéro du code-barres.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body = {
      name: form.name.trim(),
      category: form.category.trim() || null,
      unit: form.unit.trim(),
      sale_price: parseNumber(form.sale_price),
      initial_quantity: form.initial_quantity === "" ? 0 : parseNumber(form.initial_quantity),
      low_stock_threshold: form.low_stock_threshold === "" ? null : parseNumber(form.low_stock_threshold),
      expiry_date: form.expiry_date || null,
      description: form.description.trim() || null,
      code_type: codeType,
      ...(codeType === "barcode" ? { code: code.trim() } : {}),
      ...(isOwner && form.purchase_price !== "" ? { purchase_price: parseNumber(form.purchase_price) } : {}),
    };
    setSaving(true);
    try {
      const p = await api.post("/products", body);
      upsert(p);
      setCreated(p);
      setStep("done");
    } catch (err) {
      if (err.status === 409 && err.code === "PRODUCT_EXISTS") { setExistsId(err.data.product_id); setStep("exists"); }
      else toast.push(errorText(err), "error");
    } finally {
      setSaving(false);
    }
  }

  if (step === "choose") {
    return (
      <div className="page page-narrow">
        <BackBar title="Nouveau produit" onBack={back} />
        <h1 className="big-title">Ton produit a-t-il un code-barres ?</h1>
        <p className="muted">Un produit n'a qu'un seul code.</p>
        <div className="choice-list">
          <div className={cx("choice", codeType === "barcode" && "on")}>
            <button type="button" className="choice-head" onClick={() => setCodeType("barcode")}>
              <span className="choice-icon"><Barcode size={28} /></span>
              <strong>Mon produit a un code-barres</strong>
              <span>Scanne-le, ou tape le numéro sous les barres.</span>
            </button>
            {codeType === "barcode" && (
              typing ? (
                <form className="inline-form" onSubmit={(e) => { e.preventDefault(); applyBarcode(code); }}>
                  <input autoFocus inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Numéro du code-barres" maxLength={64} aria-label="Numéro du code-barres" />
                  <Button type="submit" disabled={!code.trim()}>Continuer</Button>
                </form>
              ) : (
                <div className="choice-actions">
                  <Button icon={ScanLine} onClick={() => setCamera(true)}>Scanner</Button>
                  <Button kind="ghost" onClick={() => setTyping(true)}>Saisir le numéro</Button>
                </div>
              )
            )}
          </div>
          <button type="button" className={cx("choice", "choice-head")} onClick={() => { setCodeType("qr"); setCode(""); setStep("form"); }}>
            <span className="choice-icon"><QrCode size={28} /></span>
            <strong>Pas de code-barres</strong>
            <span>On crée un QR code à imprimer et coller sur le produit.</span>
          </button>
        </div>
        {camera && <CameraScanner title="Scanner le code-barres" continuous={false} onClose={() => setCamera(false)} onCode={(c) => { setCamera(false); applyBarcode(c); }} />}
      </div>
    );
  }

  if (step === "exists") {
    return (
      <div className="page page-narrow">
        <BackBar title="Nouveau produit" onBack={back} />
        <ExistsPanel
          productId={existsId}
          onRestock={() => navigate(`/produits/${existsId}`, { state: { restock: true, from: state?.from } })}
          onAgain={() => { setExistsId(null); setCode(""); setTyping(false); setStep("choose"); }}
        />
      </div>
    );
  }

  if (step === "done" && created) {
    return (
      <div className="page page-narrow">
        <div className="card done-card">
          <span className="done-check"><Check size={26} strokeWidth={3} /></span>
          <h2>Produit ajouté</h2>
          <p className="muted">{created.name} · {fc(created.sale_price)}</p>
          {created.code_type === "qr" && (
            <>
              <QrPreview productId={created.id} />
              <span className="mono muted">{created.code}</span>
              <Button kind="ghost" icon={Printer} onClick={() => openBlob("POST", "/products/qr-sheet", { product_ids: [created.id] }).catch((e) => toast.push(errorText(e), "error"))}>Imprimer le QR code</Button>
            </>
          )}
          <div className="done-actions">
            {fromCaisse ? (
              <>
                <Button icon={ShoppingCart} onClick={() => { cart.add(created, created.code); navigate("/caisse"); }}>Ajouter au panier</Button>
                <Button kind="soft" onClick={() => navigate("/caisse")}>Retour à la caisse</Button>
              </>
            ) : (
              <>
                <Button onClick={() => navigate("/produits")}>Voir les produits</Button>
                <Button kind="soft" icon={Plus} onClick={() => { setForm(EMPTY); setCode(""); setCodeType(null); setTyping(false); setCreated(null); setStep("choose"); }}>Ajouter un autre</Button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-narrow">
      <BackBar title="Nouveau produit" onBack={() => (state?.code ? back() : setStep("choose"))} />
      <form onSubmit={submit} noValidate>
        <div className="code-pill">
          {codeType === "barcode" ? <Barcode size={18} /> : <QrCode size={18} />}
          {codeType === "barcode" ? (
            <input className="mono" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code-barres" maxLength={64} />
          ) : (
            <span>QR code créé à l'enregistrement</span>
          )}
        </div>
        {errors.code && <div className="field-error">{errors.code}</div>}
        <ProductFields form={form} setForm={setForm} errors={errors} isOwner={isOwner} creating />
        <div className="form-actions">
          <Button kind="soft" onClick={back}>Annuler</Button>
          <Button type="submit" icon={Check} loading={saving}>Enregistrer</Button>
        </div>
      </form>
    </div>
  );
}

export function ProductEdit({ id }) {
  const { auth, isOwner } = useAuth();
  const { state, navigate } = useRouter();
  const { upsert } = useProducts();
  const toast = useToast();
  const motif = useMotifFlow();
  const [product, setProduct] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [restock, setRestock] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get(`/products/${id}`).then((p) => {
      if (!alive) return;
      setProduct(p);
      setForm(toForm(p));
      if (state?.restock && !p.is_archived) setRestock(true);
    }).catch((e) => alive && setLoadError(e));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const original = useMemo(() => (product ? toForm(product) : null), [product]);
  const back = () => (state?.from === "caisse" ? navigate("/caisse") : navigate("/produits"));

  if (loadError) return <div className="page"><BackBar title="Produit" onBack={back} /><div className="alert alert-error">{errorText(loadError)}</div></div>;
  if (!product) return <div className="page"><Spinner /></div>;

  function diff() {
    const d = {};
    if (form.name.trim() !== original.name) d.name = form.name.trim();
    if (form.category.trim() !== original.category) d.category = form.category.trim() || null;
    if (form.unit.trim() !== original.unit) d.unit = form.unit.trim();
    if (parseNumber(form.sale_price) !== parseNumber(original.sale_price)) d.sale_price = parseNumber(form.sale_price);
    if (isOwner && form.purchase_price !== original.purchase_price && parseNumber(form.purchase_price) !== parseNumber(original.purchase_price)) {
      d.purchase_price = form.purchase_price === "" ? 0 : parseNumber(form.purchase_price);
    }
    if (form.low_stock_threshold !== original.low_stock_threshold) d.low_stock_threshold = form.low_stock_threshold === "" ? null : parseNumber(form.low_stock_threshold);
    if (form.expiry_date !== original.expiry_date) d.expiry_date = form.expiry_date || null;
    if (form.description.trim() !== original.description) d.description = form.description.trim() || null;
    return d;
  }

  function onSaved(p) {
    setProduct(p);
    setForm(toForm(p));
    upsert(p);
    toast.push("Produit enregistré.", "success");
  }

  async function save(e) {
    e.preventDefault();
    const errs = validate(form, { isOwner, creating: false });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const changes = diff();
    if (!Object.keys(changes).length) { toast.push("Aucune modification.", "info"); return; }
    // Changement de prix par un caissier : fenêtre de motif. Les autres champs : sans motif (tracés par le backend).
    if (!isOwner && "sale_price" in changes) {
      motif.start({
        title: "Pourquoi changer le prix ?",
        subtitle: <span className="num">{fc(product.sale_price)} → <b>{fc(changes.sale_price)}</b></span>,
        run: (m) => api.patch(`/products/${id}`, { ...changes, ...m }),
        onDone: onSaved,
      });
      return;
    }
    setSaving(true);
    try { onSaved(await api.patch(`/products/${id}`, changes)); }
    catch (err) {
      if (err.status === 400 && err.code === "MOTIF_REQUIRED") {
        motif.start({ title: "Pourquoi changer le prix ?", run: (m) => api.patch(`/products/${id}`, { ...changes, ...m }), onDone: onSaved });
      } else toast.push(errorText(err), "error");
    } finally { setSaving(false); }
  }

  function archive() {
    setConfirmArchive(false);
    motif.start({
      title: "Pourquoi archiver ce produit ?",
      subtitle: product.name,
      run: (m) => api.del(`/products/${id}`, m || undefined),
      onDone: (p) => { upsert({ ...p, is_archived: true }); toast.push("Produit archivé.", "success"); navigate("/produits", { replace: true }); },
    });
  }

  return (
    <div className="page page-narrow">
      <BackBar title="Modifier le produit" onBack={back} />
      <div className="edit-head">
        <Thumb name={product.name} size={60} />
        <div>
          <h1>{product.name}</h1>
          <span className="mono muted">{product.code}</span>
        </div>
      </div>
      {product.is_archived ? (
        <div className="alert alert-warn">Produit archivé : il n'apparaît plus dans les listes ni dans la caisse.</div>
      ) : (
        <div className="tile stock-tile">
          <div><span className="muted">Stock actuel · unité : {product.unit}</span><b className="num">{qty(product.quantity)}</b></div>
          <StockBadge product={product} business={auth.business} />
          <Button icon={Boxes} onClick={() => setRestock(true)}>Réapprovisionner</Button>
        </div>
      )}
      {product.code_type === "qr" && !product.is_archived && (
        <div className="qr-row">
          <QrPreview productId={product.id} />
          <Button kind="ghost" icon={Printer} onClick={() => openBlob("POST", "/products/qr-sheet", { product_ids: [product.id] }).catch((e) => toast.push(errorText(e), "error"))}>Imprimer le QR code</Button>
        </div>
      )}
      {!product.is_archived && (
        <form onSubmit={save} noValidate>
          <ProductFields form={form} setForm={setForm} errors={errors} isOwner={isOwner} />
          <div className="form-actions">
            <Button kind="danger" icon={Archive} onClick={() => setConfirmArchive(true)}>Archiver</Button>
            <span className="grow" />
            <Button type="submit" icon={Check} loading={saving}>Enregistrer</Button>
          </div>
        </form>
      )}
      <ConfirmModal
        open={confirmArchive}
        title="Archiver ce produit ?"
        text={`« ${product.name} » ne sera plus proposé dans la caisse ni dans les listes. Les ventes passées restent intactes.`}
        confirmLabel="Archiver"
        danger
        onClose={() => setConfirmArchive(false)}
        onConfirm={archive}
      />
      {restock && <RestockModal product={product} onClose={() => setRestock(false)} onDone={(p) => { setProduct(p); }} />}
      {motif.modal}
    </div>
  );
}
