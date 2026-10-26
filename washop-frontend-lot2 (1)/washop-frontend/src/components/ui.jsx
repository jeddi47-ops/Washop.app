import { useEffect } from "react";
import { X, Loader2 } from "lucide-react";
import { stockStatus } from "../state/data";

export const cx = (...a) => a.filter(Boolean).join(" ");

// Vignette par défaut : initiale du nom sur fond vert clair (aucun produit n'a d'image dans ce lot).
export function Thumb({ name, size = 44 }) {
  return (
    <span className="thumb" style={{ width: size, height: size, fontSize: Math.round(size * 0.42), borderRadius: Math.round(size * 0.28) }} aria-hidden="true">
      {(name || "?").trim().charAt(0).toUpperCase()}
    </span>
  );
}

const BADGES = {
  actif: ["Actif", "green"],
  normal: ["Normal", "green"],
  faible: ["Stock faible", "yellow"],
  rupture: ["Rupture", "red"],
  payee: ["Payée", "paid"],
  annulee: ["Annulée", "red"],
  credit: ["À crédit", "yellow"],
  desactive: ["Désactivé", "grey"],
};

export function Badge({ kind, children }) {
  const [label, tone] = BADGES[kind] || [children || kind, "grey"];
  return <span className={`badge badge-${tone}`}><i />{children || label}</span>;
}

// Liste produits : Actif / Stock faible / Rupture. Stock : Normal / Stock faible / Rupture.
export function StockBadge({ product, business, normalLabel = "actif" }) {
  const s = stockStatus(product, business);
  return <Badge kind={s === "normal" ? normalLabel : s} />;
}

export function SaleBadge({ status, credit }) {
  return <Badge kind={status === "cancelled" ? "annulee" : credit ? "credit" : "payee"} />;
}

export function Button({ kind = "primary", icon: Icon, children, loading, className, size, ...rest }) {
  return (
    <button type="button" className={cx("btn", `btn-${kind}`, size && `btn-${size}`, className)} disabled={loading || rest.disabled} {...rest}>
      {loading ? <Loader2 size={18} className="spin" /> : Icon && <Icon size={18} strokeWidth={2.2} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className, ...rest }) {
  return (
    <button type="button" className={cx("icon-btn", className)} aria-label={label} title={label} {...rest}>
      <Icon size={18} />
    </button>
  );
}

// Fenêtre : feuille en bas sur téléphone, boîte centrée sur PC.
export function Modal({ open, onClose, title, children, footer, wide, dismissable = true }) {
  useEffect(() => {
    if (!open || !dismissable) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, dismissable]);
  if (!open) return null;
  return (
    <div className="modal-root" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
      <div className="modal-backdrop" onClick={dismissable ? onClose : undefined} />
      <div className={cx("modal", wide && "modal-wide")}>
        <div className="modal-grip" />
        {(title || dismissable) && (
          <div className="modal-head">
            {title && <h2>{title}</h2>}
            {dismissable && <IconButton icon={X} label="Fermer" onClick={onClose} />}
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({ open, title, text, confirmLabel = "Confirmer", danger, onConfirm, onClose, loading }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={(
        <>
          <Button kind="soft" onClick={onClose}>Annuler</Button>
          <Button kind={danger ? "danger-fill" : "primary"} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      )}
    >
      {text && <p className="muted">{text}</p>}
    </Modal>
  );
}

export function Field({ label, hint, error, children, className }) {
  return (
    <label className={cx("field", className)}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? <span className="field-error">{error}</span> : hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ icon: Icon, title, text, action }) {
  return (
    <div className="empty">
      {Icon && <span className="empty-icon"><Icon size={26} /></span>}
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label = "Chargement…" }) {
  return <div className="spinner-row"><Loader2 size={20} className="spin" /> {label}</div>;
}

export function Stepper({ value, onChange, min = 1, size }) {
  return (
    <div className={cx("stepper", size && `stepper-${size}`)}>
      <button type="button" aria-label="Moins" disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <span className="num">{value}</span>
      <button type="button" aria-label="Plus" onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

export function Segmented({ options, value, onChange, className }) {
  return (
    <div className={cx("segmented", className)} role="radiogroup">
      {options.map((o) => (
        <button key={o.code} type="button" role="radio" aria-checked={value === o.code} className={value === o.code ? "on" : ""} onClick={() => onChange(o.code)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Logo({ light, small }) {
  return (
    <span className={cx("logo", light && "logo-light", small && "logo-small")}>
      <span className="logo-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 6l3.5 12 5-9 5 9 3.5-12" />
          <circle cx="12" cy="4.5" r="1.4" fill="#7CE0A9" stroke="none" />
        </svg>
      </span>
      <span className="logo-word">washop</span>
    </span>
  );
}
