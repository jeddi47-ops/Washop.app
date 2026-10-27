import { fc, qty, formatDateTime } from "./format";

export const MOTIFS = [
  { code: "erreur_de_saisie", label: "Erreur de saisie" },
  { code: "client_a_change_avis", label: "Client a changé d'avis" },
  { code: "produit_abime", label: "Produit abîmé" },
  { code: "autre", label: "Autre" },
];
export const MOTIF_NOTE_MIN = 10;
export const motifLabel = (code) => MOTIFS.find((m) => m.code === code)?.label || code || "";

export const PAYMENT_METHODS = [
  { code: "cash", label: "Espèces" },
  { code: "mobile_money", label: "Mobile money" },
  { code: "card", label: "Carte" },
  { code: "credit", label: "Crédit" },
];
export const paymentLabel = (code) => PAYMENT_METHODS.find((m) => m.code === code)?.label || (code === "other" ? "Autre" : code || "");

export const ROLE_LABELS = { owner: "Propriétaire", seller: "Caissier" };

export const ACTION_LABELS = {
  product_created: "Produit créé",
  product_updated: "Produit modifié",
  product_price_changed: "Prix modifié",
  product_stock_adjusted: "Stock modifié",
  product_archived: "Produit archivé",
  sale_created: "Vente créée",
  sale_cancelled: "Vente annulée",
  user_created: "Caissier créé",
  user_disabled: "Utilisateur désactivé",
  user_password_reset: "Mot de passe réinitialisé",
  login: "Connexion",
  logout: "Déconnexion",
  session_replaced: "Session remplacée",
  credit_created: "Crédit accordé",
  credit_payment_recorded: "Remboursement de crédit",
  credit_limit_override: "Limite de crédit dépassée (validée)",
  fund_started: "Fonds de réappro démarré",
  fund_adjusted: "Fonds de réappro ajusté",
};
export const actionTone = (action) =>
  ({ sale_cancelled: "red", product_archived: "red", user_disabled: "red", product_price_changed: "blue", product_created: "green", product_stock_adjusted: "green", sale_created: "green", credit_created: "blue", credit_payment_recorded: "green", credit_limit_override: "red", fund_started: "green", fund_adjusted: "blue" }[action] || "grey");

const FIELD_LABELS = {
  name: "Nom", description: "Description", category: "Catégorie", unit: "Unité", sale_price: "Prix de vente",
  purchase_price: "Prix d'achat", quantity: "Stock", low_stock_threshold: "Seuil", expiry_date: "Péremption",
  code: "Code", code_type: "Type de code", is_archived: "Statut", is_active: "Statut", device_type: "Appareil",
  status: "Statut", number: "N°", total: "Total", payment_method: "Paiement", items: "Articles", type: "Type",
  reason: "Raison", username: "Identifiant", role: "Rôle", replaced_by: "Remplacée par",
  customer_name: "Client", sale_number: "Vente", total_due: "Total dû", down_payment: "Acompte", balance: "Reste à payer",
  unit_cost: "Coût unitaire", supplier: "Fournisseur", opening_amount: "Argent de départ",
  amount: "Montant", current_debt: "Dette actuelle", new_debt: "Dette après", max_debt: "Limite", authorized_by_name: "Validé par",
};

function formatField(key, value) {
  if (value === null || value === undefined || value === "") return "—";
  switch (key) {
    case "sale_price": case "purchase_price": case "total": case "total_due": case "down_payment": case "balance":
    case "amount": case "unit_cost": case "opening_amount": case "current_debt": case "new_debt": case "max_debt": return fc(value);
    case "quantity": case "low_stock_threshold": return qty(value);
    case "expiry_date": return formatDateTime(value).slice(0, 10);
    case "is_archived": return value ? "Archivé" : "Actif";
    case "is_active": return value ? "Actif" : "Désactivé";
    case "device_type": return value === "scanner" ? "Scanner" : "Caisse";
    case "status": return value === "cancelled" ? "Annulée" : value === "completed" ? "Payée" : String(value);
    case "payment_method": return paymentLabel(value);
    case "items": return Array.isArray(value) ? `${value.length} ligne${value.length > 1 ? "s" : ""}` : String(value);
    case "type": return value === "restock" ? "Réapprovisionnement" : value === "adjustment" ? "Correction" : String(value);
    case "code_type": return value === "qr" ? "QR code" : "Code-barres";
    case "role": return ROLE_LABELS[value] || value;
    case "replaced_by": return "nouvelle session";
    default: return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

// « Prix de vente : 4 500 FC · Seuil : 10 »
export function formatAuditValue(obj) {
  if (obj === null || obj === undefined) return "—";
  if (typeof obj !== "object") return String(obj);
  const keys = Object.keys(obj);
  if (!keys.length) return "—";
  if (keys.length === 1) return formatField(keys[0], obj[keys[0]]);
  return keys.map((k) => `${FIELD_LABELS[k] || k} : ${formatField(k, obj[k])}`).join(" · ");
}
