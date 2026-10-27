"""Tests des règles du stock intelligent (sans base de données)."""
import datetime as dt
from io import BytesIO

from pypdf import PdfReader

from app.services import reappro as rules
from app.services.pdf import purchase_order_pdf

NOW = dt.datetime(2026, 10, 27, 12, 0, tzinfo=dt.timezone.utc)
SINCE = dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc)


def product(pid, name, quantity, cost=1000, price=1500, age_days=60, supplier=None):
    return {"id": pid, "name": name, "quantity": quantity, "purchase_price": cost, "sale_price": price,
            "created_at": NOW - dt.timedelta(days=age_days), "supplier": supplier, "unit": "pièce"}


def credit(down, payments, total_due=100_000, created=dt.datetime(2026, 10, 10, tzinfo=dt.timezone.utc)):
    return {"total_due": total_due, "down_payment": down, "created_at": created,
            "payments": [{"amount": a, "created_at": t} for a, t in payments]}


# ---------- fonds ----------
def test_fund_balance_adds_cost_of_sales_and_subtracts_restocks():
    assert rules.fund_balance(opening=50_000, cogs_collected=200_000, restocked_cost=120_000, adjustments=-10_000) == 120_000


def test_credit_counts_only_what_the_client_paid():
    c = credit(down=20_000, payments=[(30_000, dt.datetime(2026, 10, 15, tzinfo=dt.timezone.utc))])
    assert rules.credit_collected(c, SINCE) == 50_000
    cost, profit = rules.credit_share(c, {"total_cost": 80_000, "profit": 20_000}, SINCE)
    assert (round(cost), round(profit)) == (40_000, 10_000)  # 50 % encaissé


def test_credit_payments_before_the_start_do_not_count():
    c = credit(down=20_000, payments=[(30_000, dt.datetime(2026, 10, 15, tzinfo=dt.timezone.utc))],
               created=dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc))
    assert rules.credit_collected(c, SINCE) == 30_000  # l'acompte de septembre est avant le départ


def test_fully_paid_credit_recognises_everything_once():
    c = credit(down=40_000, payments=[(60_000, dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc))])
    cost, profit = rules.credit_share(c, {"total_cost": 80_000, "profit": 20_000}, SINCE)
    assert (cost, profit) == (80_000, 20_000)


def test_credit_without_total_due_counts_nothing():
    assert rules.credit_share({"total_due": 0, "payments": []}, {"total_cost": 5, "profit": 5}, SINCE) == (0.0, 0.0)


# ---------- suggestions ----------
def sugg(products, sold, budget=None, **kw):
    args = dict(days=30, cover_days=14, alert_days=7, budget=budget)
    args.update(kw)
    return rules.build_suggestions(products, sold, NOW, **args)


def test_suggested_quantity_covers_the_target_days():
    # 60 vendus en 30 jours = 2 / jour ; 14 jours = 28 ; stock 10 → il manque 18
    r = sugg([product("a", "Riz", 10)], {"a": 60})
    line = r["lines"][0]
    assert line["suggested_qty"] == 18 and line["funded_qty"] == 18
    assert line["line_total"] == 18_000 and line["days_left"] == 5.0 and line["tier"] == "bientot"


def test_products_that_sell_enough_stock_are_not_suggested():
    assert sugg([product("a", "Riz", 40)], {"a": 60})["lines"] == []


def test_products_that_do_not_sell_are_not_suggested():
    assert sugg([product("a", "Dormant", 0)], {})["lines"] == []


def test_budget_limits_the_quantities_and_never_goes_negative():
    # besoin 18 × 1 000 = 18 000 ; budget 10 500 → 10 unités
    r = sugg([product("a", "Riz", 10)], {"a": 60}, budget=10_500)
    line = r["lines"][0]
    assert line["funded_qty"] == 10 and line["line_total"] == 10_000
    assert r["remaining"] == 500 and line["suggested_qty"] == 18


def test_budget_goes_to_ruptures_first_then_to_the_best_earners():
    products = [
        product("rup", "Sucre", 0, cost=1000, price=1100),       # rupture, petite marge
        product("top", "Huile", 5, cost=1000, price=3000),       # bientôt, grosse marge
        product("mid", "Savon", 5, cost=1000, price=1200),       # bientôt, petite marge
    ]
    r = sugg(products, {"rup": 60, "top": 60, "mid": 60}, budget=60_000)
    assert [l["product_id"] for l in r["lines"]] == ["rup", "top", "mid"]


def test_empty_fund_funds_nothing_but_keeps_the_needs_visible():
    r = sugg([product("a", "Riz", 0)], {"a": 60}, budget=0)
    assert r["lines"][0]["funded_qty"] == 0 and r["lines"][0]["suggested_qty"] == 28
    assert r["total"] == 0 and r["needed_total"] == 28_000


def test_no_budget_means_no_limit():
    r = sugg([product("a", "Riz", 0)], {"a": 60}, budget=None)
    assert r["lines"][0]["funded_qty"] == 28 and r["remaining"] is None


def test_product_without_purchase_price_is_reported_not_suggested():
    r = sugg([product("a", "Sans prix", 0, cost=0)], {"a": 60})
    assert r["lines"] == [] and r["missing_cost"] == [{"product_id": "a", "name": "Sans prix"}]


def test_new_product_uses_a_7_day_minimum_window():
    # créé il y a 2 jours, 14 vendus : fenêtre minimale de 7 jours → 2 / jour
    r = sugg([product("a", "Nouveau", 0, age_days=2)], {"a": 14})
    assert r["lines"][0]["sold_per_day"] == 2.0


# ---------- bon de commande ----------
def test_purchase_order_pdf_lists_products_and_total():
    business = {"name": "Boutique Test", "currency": "FC", "timezone": "Africa/Kinshasa", "phone": "+243 800 000 000"}
    lines = [{"name": "Riz parfumé 5 kg", "code": "r1", "unit": "sac", "quantity": 10, "unit_cost": 22_000, "line_total": 220_000},
             {"name": "Sucre Kwilu 1 kg", "code": "s1", "unit": "kg", "quantity": 20, "unit_cost": 3_000, "line_total": 60_000}]
    pdf = purchase_order_pdf(business, "Marché Central", lines, "BC-20261027-1200", NOW)
    text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(pdf)).pages)
    assert "Bon de commande BC-20261027-1200" in text and "Marché Central" in text
    assert "Riz parfumé 5 kg" in text and "Total : 280 000 FC" in text


def test_purchase_order_pdf_handles_long_lists_over_several_pages():
    business = {"name": "Boutique Test", "currency": "FC", "timezone": "UTC"}
    lines = [{"name": f"Produit {i}", "code": str(i), "unit": "", "quantity": 1, "unit_cost": 1000, "line_total": 1000} for i in range(120)]
    pdf = purchase_order_pdf(business, None, lines, "BC-X", NOW)
    reader = PdfReader(BytesIO(pdf))
    assert len(reader.pages) >= 3
    assert "Total : 120 000 FC" in reader.pages[-1].extract_text()
