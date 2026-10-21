// Montants : « 1 248 500 FC ». Espace insécable entre les milliers et avant FC (jamais de retour à la ligne).
const NBSP = "\u00A0";

export function groupThousands(intString) {
  return intString.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

export function fc(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return `0${NBSP}FC`;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  const sign = n < 0 ? "-" : "";
  const decimals = dec === "00" ? "" : `,${dec}`;
  return `${sign}${groupThousands(int)}${decimals}${NBSP}FC`;
}

// Quantités : 12 ; 1,5 ; 1 200
export function qty(value) {
  const n = Number(value) || 0;
  const [int, dec] = String(Math.abs(Math.round(n * 1000) / 1000)).split(".");
  return `${n < 0 ? "-" : ""}${groupThousands(int)}${dec ? `,${dec}` : ""}`;
}

// Saisie d'un montant ou d'une quantité : accepte « 4 500 », « 4500 », « 1,5 ».
export function parseNumber(input) {
  if (input === null || input === undefined) return NaN;
  const clean = String(input).replace(/[\s\u00A0\u202F]/g, "").replace(",", ".");
  if (clean === "") return NaN;
  return Number(clean);
}

const dateTime = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const timeOnly = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dayLong = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

// Le backend renvoie des dates UTC sans fuseau (« 2026-10-19T08:42:00 ») : on les lit comme UTC.
export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value);
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(s);
  return new Date(hasZone || s.length <= 10 ? s : `${s}Z`);
}

export function formatDateTime(value) {
  const d = toDate(value);
  return d ? dateTime.format(d).replace(",", "") : "—";
}

export function formatTime(value) {
  const d = toDate(value);
  return d ? timeOnly.format(d) : "";
}

export function formatDayLong(date = new Date()) {
  const s = dayLong.format(date);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Date du jour (AAAA-MM-JJ) dans le fuseau du commerce.
export function todayIn(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA").format(new Date());
  }
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function initials(name = "") {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";
}
