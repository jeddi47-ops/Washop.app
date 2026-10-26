"""Tests des règles de calcul du crédit (sans base de données)."""
import datetime as dt

import pytest

from app.services import credit as rules

START = dt.date(2026, 10, 24)


def terms(**kw):
    base = dict(subtotal=100_000, interest_percent=15, min_down_percent=0, down_payment=0,
                installment_amount=25_000, frequency="weekly", start=START)
    base.update(kw)
    return rules.compute_terms(**base)


def test_interest_is_added_to_the_price():
    t = terms()
    assert t["subtotal"] == 100_000
    assert t["interest_amount"] == 15_000
    assert t["total_due"] == 115_000
    assert t["balance"] == 115_000


def test_zero_interest():
    assert terms(interest_percent=0)["total_due"] == 100_000


def test_down_payment_reduces_the_balance():
    t = terms(down_payment=30_000, installment_amount=20_000)
    assert t["balance"] == 85_000
    assert t["installments_count"] == 5  # 4 x 20 000 + 5 000
    assert [r["amount"] for r in t["schedule"]] == [20_000, 20_000, 20_000, 20_000, 5_000]
    assert sum(r["amount"] for r in t["schedule"]) == t["balance"]


def test_minimum_down_payment_is_a_percent_of_the_total_with_interest():
    # 20 % de 115 000 = 23 000
    assert terms(min_down_percent=20, down_payment=23_000)["down_payment"] == 23_000
    with pytest.raises(rules.CreditError, match="acompte"):
        terms(min_down_percent=20, down_payment=22_000)
    assert terms(min_down_percent=20, down_payment=23_000)["min_down"] == 23_000


def test_one_cent_tolerance_on_minimum_down():
    assert terms(subtotal=100, interest_percent=0, min_down_percent=33.33, down_payment=33.32)["down_payment"] == 33.32


def test_down_payment_must_stay_below_the_total():
    with pytest.raises(rules.CreditError, match="vente normale"):
        terms(down_payment=115_000)


def test_installment_larger_than_balance_is_one_payment():
    t = terms(installment_amount=999_999)
    assert t["installments_count"] == 1
    assert t["installment_amount"] == 115_000


def test_too_many_installments_refused():
    with pytest.raises(rules.CreditError, match="trop petit"):
        terms(installment_amount=1)


def test_invalid_inputs():
    with pytest.raises(rules.CreditError):
        terms(frequency="daily")
    with pytest.raises(rules.CreditError):
        terms(installment_amount=0)
    with pytest.raises(rules.CreditError):
        terms(interest_percent=150)
    with pytest.raises(rules.CreditError):
        terms(subtotal=0)


def test_weekly_dates():
    s = terms()["schedule"]
    assert s[0]["due_date"] == "2026-10-31"
    assert s[1]["due_date"] == "2026-11-07"


def test_monthly_dates_keep_day_and_clamp_end_of_month():
    s = terms(frequency="monthly", installment_amount=20_000, start=dt.date(2026, 1, 31))["schedule"]
    assert [r["due_date"] for r in s[:3]] == ["2026-02-28", "2026-03-31", "2026-04-30"]  # pas de dérive


def test_add_months_across_years_and_leap_year():
    assert rules.add_months(dt.date(2027, 12, 15), 2) == dt.date(2028, 2, 15)
    assert rules.add_months(dt.date(2027, 12, 31), 2) == dt.date(2028, 2, 29)


def _credit(payments=None, status="open"):
    t = terms(down_payment=15_000, installment_amount=20_000)  # reste 100 000 -> 5 x 20 000
    return {"id": "c1", "business_id": "b1", "status": status, "customer_name": "A", "customer_id_number": "123456789",
            "total_due": t["total_due"], "down_payment": t["down_payment"], "schedule": t["schedule"],
            "payments": payments or []}


def test_view_nothing_paid_yet_and_not_late():
    v = rules.view(_credit(), START)
    assert v["balance"] == 100_000
    assert v["paid_total"] == 15_000
    assert v["is_overdue"] is False
    assert v["next_due"] == {"due_date": "2026-10-31", "amount": 20_000}
    assert all(r["status"] == "upcoming" for r in v["schedule"])


def test_view_payments_cover_installments_in_order():
    v = rules.view(_credit([{"amount": 30_000}]), START)
    assert v["balance"] == 70_000
    assert [r["status"] for r in v["schedule"]][:3] == ["paid", "partial", "upcoming"]
    assert v["next_due"] == {"due_date": "2026-11-07", "amount": 10_000}


def test_view_late_installments():
    # 10 jours après la première échéance (31/10) : deux échéances en retard (31/10 et 07/11)
    v = rules.view(_credit(), dt.date(2026, 11, 10))
    assert v["is_overdue"] is True
    assert v["overdue_amount"] == 40_000  # 31/10 et 07/11 sont dépassées
    assert v["overdue_days"] == 10
    v2 = rules.view(_credit([{"amount": 20_000}]), dt.date(2026, 11, 10))
    assert v2["overdue_amount"] == 20_000  # la première échéance est payée, seule celle du 07/11 est en retard
    assert v2["overdue_days"] == 3


def test_due_today_is_not_late():
    v = rules.view(_credit(), dt.date(2026, 10, 31))
    assert v["is_overdue"] is False


def test_closed_credit_has_no_next_due_or_overdue():
    v = rules.view(_credit(status="paid"), dt.date(2030, 1, 1))
    assert v["next_due"] is None and v["is_overdue"] is False and v["overdue_amount"] == 0


def test_mask_id():
    assert rules.mask_id("123456789") == "•••••6789"
    assert rules.mask_id("AB-123 456") == "••••3456"  # les séparateurs de saisie ne comptent pas
    assert rules.mask_id("123") == "••••"
    assert rules.mask_id(None) == "••••"


def test_fmt_money():
    assert rules.fmt_money(12500) == "12 500 FC"
    assert rules.fmt_money(12500.5, "USD") == "12 500,50 USD"


def test_id_key_ignores_spaces_dashes_and_case():
    assert rules.id_key("ab-123 456") == "AB123456"
    assert rules.id_key(" 1234.5678 ") == "12345678"
    assert rules.id_key(None) == ""


def test_due_week_amount_counts_the_next_seven_days_only():
    # échéances : 31/10, 07/11, 14/11, 21/11, 28/11 (20 000 chacune). Le 24/10 : seule celle du 31/10 est dans les 7 jours.
    v = rules.view(_credit(), START)
    assert v["due_week_amount"] == 20_000
    # le 25/10 : le 31/10 (J+6) et rien d'autre ; le 31/10 : 31/10 (J+0) et 07/11 (J+7)
    assert rules.view(_credit(), dt.date(2026, 10, 31))["due_week_amount"] == 40_000
    # une échéance en retard n'est pas comptée dans « cette semaine » (elle est dans le retard)
    assert rules.view(_credit(), dt.date(2026, 11, 1))["due_week_amount"] == 20_000
