"""
Stock intelligent : fonds de réappro et suggestions d'achat. Fonctions pures (testables sans base de données).

Règles :
- Le fonds se calcule à la volée à partir des ventes, jamais stocké : une vente annulée le corrige toute seule.
- Seul l'argent réellement encaissé compte. Pour une vente à crédit, on reconnaît le coût et le bénéfice
  au prorata de ce que le client a déjà payé (acompte + remboursements).
- Le fonds = départ + coût d'achat des produits vendus et encaissés − coût des réapprovisionnements ± ajustements.
"""
import datetime as dt
import math


def money(value) -> float:
    return round(float(value or 0), 2)


def aware(value: dt.datetime) -> dt.datetime:
    """Les dates de la base sont en UTC ; une date sans fuseau est lue comme UTC."""
    return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)


def credit_collected(credit: dict, since: dt.datetime) -> float:
    """Argent encaissé sur ce crédit depuis `since` : acompte (à la date de la vente), puis chaque remboursement."""
    total = 0.0
    down = float(credit.get("down_payment") or 0)
    if down > 0 and aware(credit["created_at"]) >= since:
        total += down
    for payment in credit.get("payments") or []:
        if aware(payment["created_at"]) >= since:
            total += float(payment["amount"])
    return total


def credit_share(credit: dict, sale: dict, since: dt.datetime) -> tuple[float, float]:
    """(coût, bénéfice) reconnus pour une vente à crédit : part déjà encaissée du total dû (intérêts compris)."""
    total_due = float(credit.get("total_due") or 0)
    if total_due <= 0:
        return 0.0, 0.0
    ratio = min(1.0, credit_collected(credit, since) / total_due)
    return float(sale.get("total_cost") or 0) * ratio, float(sale.get("profit") or 0) * ratio


def fund_balance(opening: float, cogs_collected: float, restocked_cost: float, adjustments: float) -> float:
    return money(opening + cogs_collected - restocked_cost + adjustments)


def window_days(age_days: int, max_days: int) -> int:
    """Même logique que la prévision de rupture : au moins 7 jours, au plus `max_days`, ou l'âge du produit."""
    return max(7, min(max_days, age_days))


def build_suggestions(products: list[dict], sold_by_product: dict, now: dt.datetime, *, days: int, cover_days: int,
                      alert_days: int, budget: float | None) -> dict:
    """
    Quoi racheter, et combien le fonds permet d'acheter.
    - rythme = ventes de la fenêtre / jours de la fenêtre
    - à racheter = de quoi couvrir `cover_days` jours de ventes, moins le stock actuel
    - priorité : rupture, puis rupture proche, puis le reste ; à priorité égale, le produit qui rapporte le plus par jour
    - budget None : pas de limite (le suivi du fonds n'est pas démarré)
    """
    candidates, missing_cost = [], []
    for p in products:
        sold = float(sold_by_product.get(p["id"], 0) or 0)
        if sold <= 0:
            continue  # ne se vend pas : on ne le propose pas
        cost = float(p.get("purchase_price") or 0)
        if cost <= 0:
            missing_cost.append({"product_id": p["id"], "name": p["name"]})
            continue
        age = (now - aware(p["created_at"])).days
        window = window_days(age, days)
        daily = sold / window
        quantity = float(p.get("quantity") or 0)
        need = math.ceil(daily * cover_days - quantity - 1e-9)
        if need <= 0:
            continue
        days_left = quantity / daily
        tier = "rupture" if quantity <= 0 else "bientot" if days_left <= alert_days else "prevoir"
        margin = float(p.get("sale_price") or 0) - cost
        candidates.append({
            "tier": tier,
            "rank": (0 if tier == "rupture" else 1 if tier == "bientot" else 2, -(daily * margin), p["name"].lower()),
            "line": {
                "product_id": p["id"],
                "name": p["name"],
                "supplier": p.get("supplier"),
                "unit": p.get("unit"),
                "quantity": quantity,
                "sold_per_day": round(daily, 2),
                "days_left": round(days_left, 1),
                "tier": tier,
                "unit_cost": money(cost),
                "suggested_qty": need,
            },
        })
    candidates.sort(key=lambda c: c["rank"])

    remaining = None if budget is None else max(0.0, float(budget))
    lines = []
    for c in candidates[:100]:
        line = c["line"]
        cost = line["unit_cost"]
        need = line["suggested_qty"]
        if remaining is None or need * cost <= remaining + 1e-9:
            funded = need
        else:
            funded = max(0, math.floor(remaining / cost + 1e-9))
        if remaining is not None:
            remaining = max(0.0, round(remaining - funded * cost, 2))
        line["funded_qty"] = funded
        line["line_total"] = money(funded * cost)
        line["needed_total"] = money(need * cost)
        lines.append(line)
    return {
        "lines": lines,
        "missing_cost": missing_cost,
        "total": money(sum(l["line_total"] for l in lines)),
        "needed_total": money(sum(l["needed_total"] for l in lines)),
        "remaining": None if remaining is None else money(remaining),
    }
