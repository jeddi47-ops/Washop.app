"""Tableau de bord (patron uniquement). Journées découpées dans le fuseau du commerce. Ventes annulées exclues."""
import datetime as dt
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import get_db
from ..security import require_owner
from ..services.timezones import business_tz, local_midnight_utc, local_today

router = APIRouter(tags=["stats"])


def _period(period: str, from_: Optional[dt.date], to: Optional[dt.date], tz):
    """Renvoie (début, fin, début précédent, fin précédente) en UTC, bornes locales du commerce."""
    if period == "custom":
        if not from_ or not to:
            raise HTTPException(400, "Pour une période personnalisée, indiquez 'from' et 'to'.")
        if to < from_:
            raise HTTPException(400, "La date de fin doit être après la date de début.")
        start_d, end_d = from_, to + dt.timedelta(days=1)
    else:
        today = local_today(tz)
        if period == "today":
            start_d, end_d = today, today + dt.timedelta(days=1)
        elif period == "week":
            start_d = today - dt.timedelta(days=today.weekday())
            end_d = start_d + dt.timedelta(days=7)
        else:  # month
            start_d = today.replace(day=1)
            end_d = (start_d + dt.timedelta(days=32)).replace(day=1)
    start, end = local_midnight_utc(start_d, tz), local_midnight_utc(end_d, tz)
    length = end - start
    return start, end, start - length, start


def _match(business_id: str, start: dt.datetime, end: dt.datetime) -> dict:
    return {"business_id": business_id, "status": "completed", "created_at": {"$gte": start, "$lt": end}}


async def _totals(db, business_id: str, start, end) -> dict:
    pipeline = [
        {"$match": _match(business_id, start, end)},
        {"$group": {"_id": None, "revenue": {"$sum": "$total"}, "profit": {"$sum": "$profit"}, "count": {"$sum": 1}}},
    ]
    rows = await db.sales.aggregate(pipeline).to_list(1)
    row = rows[0] if rows else {"revenue": 0, "profit": 0, "count": 0}
    count = row["count"]
    return {
        "revenue": round(row["revenue"], 2),
        "profit": round(row["profit"], 2),
        "sales_count": count,
        "average_basket": round(row["revenue"] / count, 2) if count else 0.0,
    }


async def _units(db, business_id: str, start, end) -> float:
    """Somme des quantités vendues sur la période, sans limite de nombre de produits."""
    pipeline = [
        {"$match": _match(business_id, start, end)},
        {"$unwind": "$items"},
        {"$group": {"_id": None, "units": {"$sum": "$items.quantity"}}},
    ]
    rows = await db.sales.aggregate(pipeline).to_list(1)
    return round(rows[0]["units"], 3) if rows else 0


def _pct_change(current: float, previous: float):
    if not previous:
        return None
    return round((current - previous) / previous * 100, 1)


@router.get("/stats/summary")
async def stats_summary(
    period: Literal["today", "week", "month", "custom"] = "today",
    from_: Optional[dt.date] = Query(None, alias="from"),
    to: Optional[dt.date] = None,
    user: dict = Depends(require_owner),
    db=Depends(get_db),
):
    business_id = user["business_id"]
    tz = await business_tz(db, business_id)
    start, end, prev_start, prev_end = _period(period, from_, to, tz)
    current = await _totals(db, business_id, start, end)
    previous = await _totals(db, business_id, prev_start, prev_end)
    today_start, today_end, _, _ = _period("today", None, None, tz)
    units_today = await _units(db, business_id, today_start, today_end)
    return {
        "period": period,
        "units_sold_today": units_today,
        "timezone": tz.key,
        "start": start,
        "end": end,
        **current,
        "previous": previous,
        "change_pct": {
            "revenue": _pct_change(current["revenue"], previous["revenue"]),
            "profit": _pct_change(current["profit"], previous["profit"]),
            "sales_count": _pct_change(current["sales_count"], previous["sales_count"]),
        },
    }


@router.get("/stats/sales-by-day")
async def sales_by_day(
    from_: Optional[dt.date] = Query(None, alias="from"),
    to: Optional[dt.date] = None,
    user: dict = Depends(require_owner),
    db=Depends(get_db),
):
    business_id = user["business_id"]
    tz = await business_tz(db, business_id)
    to = to or local_today(tz)
    from_ = from_ or (to - dt.timedelta(days=29))
    start, end = local_midnight_utc(from_, tz), local_midnight_utc(to + dt.timedelta(days=1), tz)
    pipeline = [
        {"$match": _match(business_id, start, end)},
        {"$group": {
            # $dateToString avec le fuseau du commerce : une vente de 23h30 locale tombe bien le bon jour
            "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$created_at", "timezone": tz.key}},
            "revenue": {"$sum": "$total"},
            "profit": {"$sum": "$profit"},
            "sales_count": {"$sum": 1},
        }},
        {"$sort": {"_id": 1}},
    ]
    rows = await db.sales.aggregate(pipeline).to_list(None)
    return [
        {"date": r["_id"], "revenue": round(r["revenue"], 2), "profit": round(r["profit"], 2), "sales_count": r["sales_count"]}
        for r in rows
    ]


@router.get("/stats/top-products")
async def top_products(
    period: Literal["today", "week", "month", "custom"] = "month",
    from_: Optional[dt.date] = Query(None, alias="from"),
    to: Optional[dt.date] = None,
    limit: int = Query(10, ge=1, le=100),
    user: dict = Depends(require_owner),
    db=Depends(get_db),
):
    business_id = user["business_id"]
    tz = await business_tz(db, business_id)
    start, end, _, _ = _period(period, from_, to, tz)
    pipeline = [
        {"$match": _match(business_id, start, end)},
        {"$unwind": "$items"},
        {"$group": {
            "_id": "$items.product_id",
            "name": {"$first": "$items.name"},
            "quantity_sold": {"$sum": "$items.quantity"},
            "revenue": {"$sum": "$items.line_total"},
        }},
    ]
    rows = await db.sales.aggregate(pipeline).to_list(None)
    sold_ids = [r["_id"] for r in rows]
    ranked = sorted(rows, key=lambda r: r["quantity_sold"], reverse=True)[:limit]
    not_selling = [
        {"product_id": p["id"], "name": p["name"], "quantity": p["quantity"]}
        async for p in db.products.find(
            {"business_id": business_id, "is_archived": False, "id": {"$nin": sold_ids}},
            {"_id": 0, "id": 1, "name": 1, "quantity": 1},
        ).limit(50)
    ]
    return {
        "period_start": start,
        "period_end": end,
        "top_products": [
            {"product_id": r["_id"], "name": r["name"], "quantity_sold": r["quantity_sold"], "revenue": round(r["revenue"], 2)}
            for r in ranked
        ],
        "not_selling": not_selling,
    }
