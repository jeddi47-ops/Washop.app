"""
Crédit client : intérêts, acompte, échéancier et état d'un crédit.

Fonctions pures (aucun accès à la base) : elles sont testées dans tests/test_credit_rules.py.
Tous les montants sont calculés en Decimal puis renvoyés en float à 2 décimales, comme le reste de l'API.
Les dates d'échéance sont des chaînes ISO « AAAA-MM-JJ » (jour local du commerce), jamais des datetimes.
"""
import calendar
import datetime as dt
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")
MAX_INSTALLMENTS = 520  # garde-fou : environ 10 ans en hebdomadaire
FREQUENCIES = ("weekly", "monthly")


class CreditError(ValueError):
    """Message clair, prêt à être affiché à l'écran (réponse 400)."""


def _d(value) -> Decimal:
    return Decimal(str(value if value is not None else 0))


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, ROUND_HALF_UP)


def fmt_money(value, currency: str = "FC") -> str:
    """« 12 500 FC » ou « 12 500,50 FC »."""
    number = _money(_d(value))
    body = f"{int(number):,}" if number == number.to_integral_value() else f"{number:,.2f}"
    return body.replace(",", " ").replace(".", ",") + f" {currency}"


def add_months(day: dt.date, months: int) -> dt.date:
    """Ajoute des mois en gardant le jour du mois (31 janvier + 1 mois = 28 ou 29 février)."""
    index = day.month - 1 + months
    year = day.year + index // 12
    month = index % 12 + 1
    return dt.date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def due_date(start: dt.date, frequency: str, n: int) -> dt.date:
    """Date de la n-ième échéance, toujours calculée depuis le jour de départ (pas de dérive d'un mois à l'autre)."""
    if frequency == "weekly":
        return start + dt.timedelta(days=7 * n)
    return add_months(start, n)


def compute_terms(
    *,
    subtotal,
    interest_percent,
    min_down_percent,
    down_payment,
    installment_amount,
    frequency: str,
    start: dt.date,
    currency: str = "FC",
) -> dict:
    """
    Conditions d'un crédit.
    subtotal : total des articles. L'intérêt (en %) est fixé par le propriétaire.
    L'acompte minimum exigé est un pourcentage du TOTAL À REMBOURSER (articles + intérêt).
    """
    if frequency not in FREQUENCIES:
        raise CreditError("Choisis un paiement par semaine ou par mois.")
    subtotal = _money(_d(subtotal))
    if subtotal <= 0:
        raise CreditError("Le panier est vide.")

    pct = _d(interest_percent)
    if pct < 0 or pct > 100:
        raise CreditError("Le pourcentage d'intérêt de la boutique doit être entre 0 et 100.")
    interest = _money(subtotal * pct / 100)
    total_due = subtotal + interest

    min_pct = _d(min_down_percent)
    min_down = (total_due * min_pct / 100).quantize(CENT, ROUND_CEILING)

    down = _money(_d(down_payment))
    if down < 0:
        raise CreditError("L'acompte ne peut pas être négatif.")
    # Tolérance d'un centime : l'écran et le serveur arrondissent chacun de leur côté.
    if down + CENT < min_down:
        raise CreditError(f"Cette boutique exige un acompte d'au moins {fmt_money(min_down, currency)}.")
    if down >= total_due:
        raise CreditError("L'acompte couvre déjà tout le montant : fais plutôt une vente normale.")

    balance = total_due - down
    installment = _money(_d(installment_amount))
    if installment <= 0:
        raise CreditError("Indique combien le client paie à chaque échéance.")
    if installment > balance:
        installment = balance  # une seule échéance

    count = int((balance / installment).to_integral_value(rounding=ROUND_CEILING))
    if count > MAX_INSTALLMENTS:
        raise CreditError("Le montant par échéance est trop petit : il y aurait trop de paiements.")

    schedule, left = [], balance
    for n in range(1, count + 1):
        amount = min(installment, left)
        left -= amount
        schedule.append({"n": n, "due_date": due_date(start, frequency, n).isoformat(), "amount": float(amount)})

    return {
        "subtotal": float(subtotal),
        "interest_percent": float(pct),
        "interest_amount": float(interest),
        "total_due": float(total_due),
        "min_down": float(min_down),
        "down_payment": float(down),
        "balance": float(balance),
        "frequency": frequency,
        "installment_amount": float(installment),
        "installments_count": count,
        "first_due_date": schedule[0]["due_date"],
        "last_due_date": schedule[-1]["due_date"],
        "schedule": schedule,
    }


def id_key(value: str | None) -> str:
    """Clé de comparaison d'un numéro de pièce d'identité : majuscules, sans espaces, tirets ni points."""
    return "".join(ch for ch in (value or "").upper() if ch.isalnum())


def mask_id(value: str | None) -> str:
    """« ••••••5678 » : le caissier ne voit jamais le numéro de pièce d'identité en entier."""
    key = id_key(value)  # on masque les lettres et chiffres, pas les espaces ni les tirets de saisie
    if len(key) <= 4:
        return "••••"
    return "•" * (len(key) - 4) + key[-4:]


def view(credit: dict, today: dt.date) -> dict:
    """
    État calculé d'un crédit : ce qui est payé, le reste, l'échéance suivante et le retard.
    Les paiements faits après l'acompte couvrent les échéances dans l'ordre (la plus ancienne d'abord).
    """
    out = {k: v for k, v in credit.items() if k not in ("_id", "business_id")}
    payments = credit.get("payments") or []
    repaid = sum((_d(p["amount"]) for p in payments), Decimal("0"))
    total_due = _d(credit["total_due"])
    down = _d(credit.get("down_payment"))
    balance = total_due - down - repaid
    if balance < 0:
        balance = Decimal("0")

    pool = repaid
    week_end = today + dt.timedelta(days=7)
    due_week = Decimal("0")
    rows, next_due, overdue, first_late = [], None, Decimal("0"), None
    for row in credit.get("schedule") or []:
        amount = _d(row["amount"])
        applied = min(pool, amount)
        pool -= applied
        remaining = amount - applied
        late = dt.date.fromisoformat(row["due_date"]) < today
        if remaining <= 0:
            status = "paid"
        elif late:
            status = "late"
        elif applied > 0:
            status = "partial"
        else:
            status = "upcoming"
        if remaining > 0:
            if next_due is None:
                next_due = {"due_date": row["due_date"], "amount": float(remaining)}
            if late:
                overdue += remaining
                first_late = first_late or row["due_date"]
            elif dt.date.fromisoformat(row["due_date"]) <= week_end:
                due_week += remaining  # à payer dans les 7 jours (aujourd'hui compris)
        rows.append({**row, "paid": float(applied), "remaining": float(remaining), "status": status})

    is_open = credit.get("status") == "open"
    out.update({
        "balance": float(balance),
        "repaid": float(repaid),
        "paid_total": float(down + repaid),
        "schedule": rows,
        "next_due": next_due if is_open else None,
        "overdue_amount": float(overdue) if is_open else 0.0,
        "due_week_amount": float(due_week) if is_open else 0.0,
        "overdue_days": (today - dt.date.fromisoformat(first_late)).days if (is_open and first_late) else 0,
        "is_overdue": bool(is_open and overdue > 0),
    })
    return out
