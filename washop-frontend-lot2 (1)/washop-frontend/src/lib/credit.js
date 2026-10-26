// Crédit client : aperçu des conditions pendant que le caissier remplit le formulaire.
// Ces calculs ne servent qu'à AFFICHER. Le serveur refait tout et fait foi : si les réglages
// du propriétaire ont changé entre-temps, il refuse la vente (409) et l'écran réaffiche les bons chiffres.
import { addDays, fc, todayIn } from "./format";

export const CREDIT_DEFAULTS = {
  credit_enabled: true,
  credit_interest_percent: 0,
  credit_min_down_percent: 0,
  credit_max_debt: 0, // 0 = pas de limite
  phone_country_code: "",
};

export const creditSettings = (business) => ({ ...CREDIT_DEFAULTS, ...(business?.settings || {}) });

export const FREQUENCIES = [
  { code: "weekly", label: "Par semaine" },
  { code: "monthly", label: "Par mois" },
];
export const frequencyLabel = (code) => (code === "weekly" ? "par semaine" : code === "monthly" ? "par mois" : "");

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const ceil2 = (n) => Math.ceil(n * 100 - 1e-7) / 100;

// 31 janvier + 1 mois = 28 (ou 29) février ; toujours calculé depuis le jour de départ (pas de dérive).
export function addMonthsIso(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function dueDate(startIso, frequency, n) {
  return frequency === "weekly" ? addDays(startIso, 7 * n) : addMonthsIso(startIso, n);
}

// « 2026-10-31 » -> « 31/10/2026 » (sans passer par Date : pas de décalage de fuseau)
export function fmtDay(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

// Montant par échéance pour payer en `count` versements : arrondi au centime supérieur, le dernier versement est plus petit.
export const installmentFromCount = (balance, count) => (count >= 1 ? ceil2(balance / count) : NaN);

// inputs : { down, frequency, installment, count, by } avec by = "amount" (montant par échéance) ou "count" (nombre de versements).
// Renvoie toujours un objet ; `error` est un message si les conditions sont impossibles, `incomplete` si on attend encore une saisie.
export function previewCredit(subtotal, settings, inputs, timeZone) {
  const pct = Number(settings.credit_interest_percent) || 0;
  const minPct = Number(settings.credit_min_down_percent) || 0;
  const interest = round2((subtotal * pct) / 100);
  const totalDue = round2(subtotal + interest);
  const minDown = ceil2((totalDue * minPct) / 100);
  const out = {
    pct, minPct, subtotal, interest, totalDue, minDown,
    down: 0, balance: totalDue, installment: 0, count: 0, first: null, last: null, schedule: [], frequency: inputs.frequency,
    error: null, incomplete: false,
  };
  if (!(subtotal > 0)) return { ...out, error: "Le panier est vide." };

  const down = Number.isFinite(inputs.down) ? inputs.down : 0;
  out.down = down;
  if (down < 0) return { ...out, error: "L'acompte ne peut pas être négatif." };
  if (down + 0.01 < minDown) return { ...out, error: `Acompte minimum exigé : ${fc(minDown)}.` };
  if (down >= totalDue) return { ...out, error: "L'acompte couvre déjà tout : fais plutôt une vente normale." };
  out.balance = round2(totalDue - down);

  const wanted = inputs.by === "count" ? installmentFromCount(out.balance, inputs.count) : inputs.installment;
  if (!Number.isFinite(wanted) || wanted <= 0) return { ...out, incomplete: true };
  out.installment = Math.min(wanted, out.balance);
  out.count = Math.ceil(out.balance / out.installment - 1e-9);
  if (out.count > 520) return { ...out, error: "Le montant par échéance est trop petit." };

  const start = todayIn(timeZone);
  let left = out.balance;
  for (let n = 1; n <= out.count; n += 1) {
    const amount = round2(Math.min(out.installment, left));
    left = round2(left - amount);
    out.schedule.push({ n, due_date: dueDate(start, inputs.frequency, n), amount });
  }
  out.first = out.schedule[0].due_date;
  out.last = out.schedule[out.schedule.length - 1].due_date;
  return out;
}

// Numéro au format international sans « + » pour wa.me. Un numéro local qui commence par 0 reçoit l'indicatif du pays
// choisi par le propriétaire (Paramètres). Sans indicatif, on garde le numéro tel quel.
export function whatsappNumber(phone, countryCode = "") {
  let digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) return digits.slice(2);
  if (String(phone).trim().startsWith("+")) return digits;
  if (digits.startsWith("0") && countryCode) return `${countryCode}${digits.slice(1)}`;
  return digits;
}

export function reminderMessage(credit, business) {
  const shop = business?.name || "la boutique";
  const name = credit.customer_name;
  const next = credit.next_due;
  if (credit.is_overdue) {
    return `Bonjour ${name}, ici ${shop}. Un versement de votre crédit est en retard : ${fc(credit.overdue_amount)} à régler. Reste à payer au total : ${fc(credit.balance)}. Merci de passer à la boutique dès que possible.`;
  }
  if (next) {
    return `Bonjour ${name}, ici ${shop}. Petit rappel : votre prochain versement de ${fc(next.amount)} est prévu le ${fmtDay(next.due_date)}. Reste à payer : ${fc(credit.balance)}. Merci !`;
  }
  return `Bonjour ${name}, ici ${shop}. Votre crédit est soldé. Merci pour votre confiance !`;
}

export function whatsappLink(credit, business) {
  const number = whatsappNumber(credit.customer_phone, business?.settings?.phone_country_code || "");
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(reminderMessage(credit, business))}`;
}
