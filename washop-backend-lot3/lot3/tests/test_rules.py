"""Tests unitaires : règles pures, sans base de données."""
import datetime as dt
import uuid
from zoneinfo import ZoneInfo

import dataclasses

import pytest
from pydantic import ValidationError
from starlette.requests import Request

from app.config import settings
from app.routers.auth import _client_ip
from app.schemas import RegisterIn, product_out, sale_out
from app.security import create_access_token, decode_access_token
from app.services.forecast import compute_forecast, forecast_window_days
from app.services.timezones import local_midnight_utc


def test_forecast_window_bounds():
    assert forecast_window_days(0) == 7
    assert forecast_window_days(10) == 10
    assert forecast_window_days(400) == 30


def test_forecast_at_risk_when_days_left_below_alert():
    result = compute_forecast(quantity=10, sold_in_window=14, window_days=7, alert_days=7)
    assert result["at_risk"] is True and result["days_left"] == 5.0


def test_forecast_no_sales_no_risk():
    result = compute_forecast(quantity=3, sold_in_window=0, window_days=30, alert_days=7)
    assert result["at_risk"] is False and result["days_left"] is None


def test_purchase_price_hidden_from_sellers():
    product = {"id": "p1", "business_id": "b", "name": "Savon", "purchase_price": 2.0, "sale_price": 5.0}
    assert "purchase_price" in product_out(product, "owner")
    assert "purchase_price" not in product_out(product, "seller")


def test_profit_and_costs_hidden_from_sellers():
    sale = {
        "id": "s1", "business_id": "b", "total": 10.0, "total_cost": 4.0, "profit": 6.0,
        "items": [{"name": "Huile", "unit_price": 5.0, "unit_cost": 2.0, "quantity": 2, "line_total": 10.0}],
    }
    seller_view = sale_out(sale, "seller")
    assert "profit" not in seller_view and "total_cost" not in seller_view
    assert "unit_cost" not in seller_view["items"][0]
    assert sale_out(sale, "owner")["profit"] == 6.0


def test_token_roundtrip_carries_business_id():
    token = create_access_token({"id": str(uuid.uuid4()), "business_id": "biz-1", "role": "owner"})
    payload = decode_access_token(token)
    assert payload["business_id"] == "biz-1" and payload["role"] == "owner"


def test_invalid_timezone_rejected():
    with pytest.raises(ValidationError):
        RegisterIn(business_name="A", name="B", email="a@b.co", password="motdepasse", timezone="Mars/Olympus")


def test_valid_timezone_accepted_and_default_utc():
    ok = RegisterIn(business_name="A", name="B", email="a@b.co", password="motdepasse", timezone="Africa/Abidjan")
    assert ok.timezone == "Africa/Abidjan"
    assert RegisterIn(business_name="A", name="B", email="a@b.co", password="motdepasse").timezone == "UTC"


def test_local_midnight_respects_business_timezone():
    # Tokyo = UTC+9 : minuit local le 15/10 correspond à 14/10 15:00 UTC
    result = local_midnight_utc(dt.date(2026, 10, 15), ZoneInfo("Asia/Tokyo"))
    assert result == dt.datetime(2026, 10, 14, 15, 0, tzinfo=dt.timezone.utc)


def _request(xff: str | None):
    headers = [(b"x-forwarded-for", xff.encode())] if xff is not None else []
    scope = {"type": "http", "headers": headers, "client": ("10.0.0.1", 1234),
             "path": "/", "query_string": b"", "method": "POST"}
    return Request(scope)


@pytest.mark.parametrize("count,expected", [
    (0, "10.0.0.1"),        # pas de proxy : IP de la connexion, X-Forwarded-For ignoré
    (1, "8.8.8.8"),         # un proxy : dernière entrée (ajoutée par le proxy)
    (2, "9.9.9.9"),         # deux proxys : avant-dernière entrée
    (4, "10.0.0.1"),        # liste plus courte que prévu (3 entrées, 4 proxys) : on garde l'IP de la connexion
])
def test_client_ip_behind_trusted_proxies(monkeypatch, count, expected):
    # Entrée la plus à gauche = client, potentiellement falsifiée (ici 1.1.1.1) : ne doit JAMAIS être retenue
    monkeypatch.setattr("app.routers.auth.settings", dataclasses.replace(settings, TRUSTED_PROXY_COUNT=count))
    assert _client_ip(_request("1.1.1.1, 9.9.9.9, 8.8.8.8")) == expected


def test_client_ip_ignores_spoofed_leading_entries_with_one_proxy(monkeypatch):
    # Un client peut ajouter n'importe quoi au début : seule la dernière entrée (ajoutée par le proxy) compte
    monkeypatch.setattr("app.routers.auth.settings", dataclasses.replace(settings, TRUSTED_PROXY_COUNT=1))
    assert _client_ip(_request("spoofed-by-client, 203.0.113.7")) == "203.0.113.7"
