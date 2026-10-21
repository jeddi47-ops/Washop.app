"""Alertes : rupture, prévision de rupture, péremption (règles 5.8 et 5.9)."""
import datetime as dt
from collections import defaultdict

from fastapi import APIRouter, Depends

from ..db import get_db
from ..security import get_current_user
from ..services.forecast import compute_forecast, forecast_window_days
from ..services.stock import utcnow

router = APIRouter(tags=["alerts"])


def _summary(product: dict, threshold: float) -> dict:
    return {
        "product_id": product["id"],
        "name": product["name"],
        "quantity": product["quantity"],
        "low_stock_threshold": threshold,
    }


@router.get("/alerts")
async def get_alerts(user: dict = Depends(get_current_user), db=Depends(get_db)):
    business_id = user["business_id"]
    now = utcnow()
    business = await db.businesses.find_one({"id": business_id})
    settings = business["settings"]

    products = [p async for p in db.products.find({"business_id": business_id, "is_archived": False}, {"_id": 0})]

    # Ventes des 30 derniers jours, par produit (fenêtre propre à chaque produit ensuite).
    since = now - dt.timedelta(days=30)
    sold_lines = defaultdict(list)
    pipeline = [
        {"$match": {"business_id": business_id, "status": "completed", "created_at": {"$gte": since}}},
        {"$unwind": "$items"},
        {"$project": {"_id": 0, "product_id": "$items.product_id", "quantity": "$items.quantity", "created_at": 1}},
    ]
    async for line in db.sales.aggregate(pipeline):
        sold_lines[line["product_id"]].append(line)

    low_stock, forecast, expiry = [], [], []
    for p in products:
        threshold = p["low_stock_threshold"] if p.get("low_stock_threshold") is not None else settings["low_stock_default_threshold"]
        quantity = p["quantity"]

        # Règle 5.8 : rupture = quantité sous le seuil.
        if quantity <= threshold:
            low_stock.append(_summary(p, threshold))

        # Règle 5.8 : prévision de rupture sur la fenêtre du produit.
        window = forecast_window_days((now - p["created_at"]).days)
        window_start = now - dt.timedelta(days=window)
        sold = sum(l["quantity"] for l in sold_lines[p["id"]] if l["created_at"] >= window_start)
        fc = compute_forecast(quantity, sold, window, settings["forecast_alert_days"])
        if fc["at_risk"]:
            forecast.append({**_summary(p, threshold), **fc})

        # Règle 5.9 : péremption, si encore en stock et proche ou dépassée.
        if p.get("expiry_date") and quantity > 0:
            days_left = (p["expiry_date"] - now).total_seconds() / 86400
            if days_left < settings["expiry_alert_days"]:
                expiry.append({
                    "product_id": p["id"],
                    "name": p["name"],
                    "quantity": quantity,
                    "expiry_date": p["expiry_date"],
                    "days_left": round(days_left, 1),
                    "expired": days_left < 0,
                })

    return {"low_stock": low_stock, "forecast": forecast, "expiry": expiry}
