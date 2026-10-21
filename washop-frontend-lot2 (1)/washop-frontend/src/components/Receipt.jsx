import { fc, formatDateTime, qty } from "../lib/format";
import { paymentLabel } from "../lib/labels";
import { SaleBadge } from "./ui";

// Reçu (ticket) d'une vente. Pour un caissier, le backend ne renvoie ni coût ni bénéfice.
export default function Receipt({ sale, business }) {
  return (
    <div className="receipt">
      <div className="receipt-head">
        <strong>{business?.name}</strong>
        {business?.address && <span>{business.address}</span>}
        {business?.phone && <span>{business.phone}</span>}
      </div>
      <div className="receipt-meta">
        <span className="mono">{sale.number}</span>
        <SaleBadge status={sale.status} />
      </div>
      <div className="receipt-sub">{formatDateTime(sale.created_at)}{sale.cashier_name ? ` · ${sale.cashier_name}` : ""}</div>
      <hr />
      {sale.items.map((it) => (
        <div key={it.product_id} className="receipt-line">
          <span className="receipt-name">{it.name}</span>
          <span className="receipt-calc"><span>{qty(it.quantity)} × {fc(it.unit_price)}</span><b>{fc(it.line_total)}</b></span>
        </div>
      ))}
      <hr />
      <div className="receipt-total"><span>TOTAL</span><b className="num">{fc(sale.total)}</b></div>
      <div className="receipt-row"><span>{paymentLabel(sale.payment_method)}</span><span>{sale.amount_received != null ? fc(sale.amount_received) : fc(sale.total)}</span></div>
      {sale.change_given != null && <div className="receipt-row"><span>Monnaie rendue</span><span>{fc(sale.change_given)}</span></div>}
      {sale.status === "cancelled" && (
        <div className="receipt-cancel">Annulée le {formatDateTime(sale.cancelled_at)}{sale.cancel_reason ? ` · ${sale.cancel_reason}` : ""}</div>
      )}
      {business?.invoice_footer && <div className="receipt-foot">{business.invoice_footer}</div>}
    </div>
  );
}
