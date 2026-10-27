"""
Stock intelligent : fonds de réappro (séparé du bénéfice), produits gagnants, suggestions d'achat, bon de commande PDF.
Tout est calculé à la volée à partir des ventes et des mouvements de stock. Ventes annulées exclues.
"""
import datetime as dt
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from ..db import get_db, run_transaction
from ..errors import AppError
from ..schemas import FundAdjustIn, FundStartIn, PurchaseOrderIn
from ..security import DEFAULT_SETTINGS, get_current_user, require_owner
from ..services import reappro as rules
from ..services.audit import audit_entry, write_audit
from ..services.pdf import purchase_order_pdf
from ..services.stock import utcnow
from ..services.timezones import business_tz, local_midnight_utc, local_today, tz_of

router = APIRouter(tags=["reappro"])


def _window(days: int, tz) -> tuple[dt.datetime, dt.datetime]:
    """Les `days` derniers jours, aujourd'hui compris, découpés dans le fuseau du commerce."""
    today = local_today(tz)
    start = local_midnight_utc(today - dt.timedelta(days=days - 1), tz)
    end = local_midnight_utc(today + dt.timedelta(days=1), tz)
    return start, end


async def _sold_by_product(db, business_id: str, start: dt.datetime, end: dt.datetime) -> dict:
    pipeline = [
        {"$match": {"business_id": business_id, "status": "completed", "created_at": {"$gte": start, "$lt": end}}},
        {"$unwind": "$items"},
        {"$group": {"_id": "$items.product_id", "quantity": {"$sum": "$items.quantity"}}},
    ]
    return {r["_id"]: r["quantity"] async for r in db.sales.aggregate(pipeline)}


async def _fund_state(db, business_id: str) -> dict:
    """Fonds de réappro et bénéfice encaissé depuis le dernier démarrage du suivi."""
    start_entry = await db.fund_entries.find_one(
        {"business_id": business_id, "type": "start"}, {"_id": 0}, sort=[("created_at", -1)]
    )
    if start_entry is None:
        return {"started": False, "since": None, "opening_amount": 0.0, "cogs_collected": 0.0, "restocked_cost": 0.0,
                "adjustments": 0.0, "reappro_budget": 0.0, "profit_collected": 0.0, "credit_outstanding": 0.0,
                "entries": []}
    since = rules.aware(start_entry["created_at"])
    opening = float(start_entry.get("amount") or 0)

    # Ventes payées tout de suite (hors crédit) : coût d'achat et bénéfice entiers.
    rows = await db.sales.aggregate([
        {"$match": {"business_id": business_id, "status": "completed", "payment_method": {"$ne": "credit"},
                    "created_at": {"$gte": since}}},
        {"$group": {"_id": None, "cost": {"$sum": "$total_cost"}, "profit": {"$sum": "$profit"}}},
    ]).to_list(1)
    cogs = float(rows[0]["cost"]) if rows else 0.0
    profit = float(rows[0]["profit"]) if rows else 0.0

    # Ventes à crédit : seulement la part déjà encaissée (acompte + remboursements depuis le départ).
    credits = await db.credits.find(
        {"business_id": business_id, "status": {"$in": ["open", "paid"]},
         "$or": [{"created_at": {"$gte": since}}, {"payments.created_at": {"$gte": since}}]},
        {"_id": 0},
    ).to_list(5000)
    if credits:
        sales = {
            s["id"]: s
            async for s in db.sales.find(
                {"business_id": business_id, "id": {"$in": [c["sale_id"] for c in credits]}, "status": "completed"},
                {"_id": 0, "id": 1, "total_cost": 1, "profit": 1},
            )
        }
        for credit in credits:
            sale = sales.get(credit["sale_id"])
            if sale is None:
                continue
            c_cost, c_profit = rules.credit_share(credit, sale, since)
            cogs += c_cost
            profit += c_profit

    # Réapprovisionnements depuis le départ. Un ancien mouvement sans coût utilise le prix d'achat actuel du produit.
    # Le stock initial (type « initial ») n'est pas payé avec l'argent des ventes : il ne compte pas.
    rows = await db.stock_movements.aggregate([
        {"$match": {"business_id": business_id, "type": "restock", "created_at": {"$gte": since}}},
        {"$lookup": {"from": "products", "localField": "product_id", "foreignField": "id", "as": "p"}},
        {"$project": {"cost": {"$multiply": [
            "$quantity_change",
            {"$ifNull": ["$unit_cost", {"$ifNull": [{"$arrayElemAt": ["$p.purchase_price", 0]}, 0]}]},
        ]}}},
        {"$group": {"_id": None, "cost": {"$sum": "$cost"}}},
    ]).to_list(1)
    restocked = float(rows[0]["cost"]) if rows else 0.0

    entries = [e async for e in db.fund_entries.find(
        {"business_id": business_id, "type": "adjustment", "created_at": {"$gte": since}}, {"_id": 0, "business_id": 0}
    ).sort("created_at", -1).limit(20)]
    adjustments = sum(float(e["amount"]) for e in entries)
    if len(entries) == 20:  # beaucoup d'ajustements : on refait la somme complète
        rows = await db.fund_entries.aggregate([
            {"$match": {"business_id": business_id, "type": "adjustment", "created_at": {"$gte": since}}},
            {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
        ]).to_list(1)
        adjustments = float(rows[0]["total"]) if rows else 0.0

    outstanding = await db.credits.aggregate([
        {"$match": {"business_id": business_id, "status": "open"}},
        {"$group": {"_id": None, "balance": {"$sum": "$balance"}}},
    ]).to_list(1)

    return {
        "started": True,
        "since": since,
        "opening_amount": rules.money(opening),
        "cogs_collected": rules.money(cogs),
        "restocked_cost": rules.money(restocked),
        "adjustments": rules.money(adjustments),
        "reappro_budget": rules.fund_balance(opening, cogs, restocked, adjustments),
        "profit_collected": rules.money(profit),
        "credit_outstanding": rules.money(outstanding[0]["balance"]) if outstanding else 0.0,
        "entries": entries[:5],
    }


@router.get("/stock/fund")
async def get_fund(user: dict = Depends(require_owner), db=Depends(get_db)):
    """Fonds de réappro et bénéfice, séparés. Propriétaire uniquement."""
    return await _fund_state(db, user["business_id"])


@router.post("/stock/fund/start", status_code=201)
async def start_fund(body: FundStartIn, user: dict = Depends(require_owner), db=Depends(get_db)):
    """
    Démarre le suivi du fonds, ou le remet à zéro (motif obligatoire dans ce cas).
    `opening_amount` : argent déjà disponible pour racheter du stock au moment du départ.
    """
    business_id = user["business_id"]
    previous = await db.fund_entries.find_one(
        {"business_id": business_id, "type": "start"}, {"_id": 0}, sort=[("created_at", -1)]
    )
    motif = (body.motif or "").strip() or None
    if previous is not None and (motif is None or len(motif) < 10):
        raise AppError(400, "Pour remettre le fonds à zéro, précise la raison (10 caractères minimum).", code="MOTIF_REQUIRED")
    entry_id = str(uuid.uuid4())
    entry = {
        "id": entry_id, "business_id": business_id, "type": "start", "amount": rules.money(body.opening_amount),
        "motif": motif, "created_by": user["id"], "created_by_name": user.get("name"), "created_at": utcnow(),
    }

    async def _txn(s):
        await db.fund_entries.insert_one(dict(entry), session=s)
        await write_audit(db, audit_entry(
            user, "fund_started", "fund", entry_id,
            old_value=None if previous is None else {"since": previous["created_at"].isoformat(), "opening_amount": previous["amount"]},
            new_value={"opening_amount": entry["amount"]},
            motif_code="autre" if motif else None, motif_note=motif,
        ), session=s)

    await run_transaction(db, _txn)
    return await _fund_state(db, business_id)


@router.post("/stock/fund/adjustments", status_code=201)
async def adjust_fund(body: FundAdjustIn, user: dict = Depends(require_owner), db=Depends(get_db)):
    """Ajoute (+) ou retire (−) de l'argent du fonds, avec un motif. Tracé dans le journal."""
    business_id = user["business_id"]
    if await db.fund_entries.find_one({"business_id": business_id, "type": "start"}, {"_id": 1}) is None:
        raise AppError(400, "Démarre d'abord le suivi du fonds de réappro.", code="FUND_NOT_STARTED")
    entry_id = str(uuid.uuid4())
    entry = {
        "id": entry_id, "business_id": business_id, "type": "adjustment", "amount": body.amount,
        "motif": body.motif, "created_by": user["id"], "created_by_name": user.get("name"), "created_at": utcnow(),
    }

    async def _txn(s):
        await db.fund_entries.insert_one(dict(entry), session=s)
        await write_audit(db, audit_entry(
            user, "fund_adjusted", "fund", entry_id, new_value={"amount": body.amount},
            motif_code="autre", motif_note=body.motif,
        ), session=s)

    await run_transaction(db, _txn)
    return await _fund_state(db, business_id)


@router.get("/stock/winners")
async def winners(
    days: int = Query(30, ge=1, le=90),
    limit: int = Query(5, ge=1, le=20),
    sort: Literal["profit", "quantity"] = "profit",
    user: dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Produits qui se vendent le mieux. Tous les rôles voient les quantités ;
    chiffre d'affaires, bénéfice et « argent immobilisé » sont réservés au propriétaire (règle 5.7).
    """
    business_id = user["business_id"]
    is_owner = user["role"] == "owner"
    tz = await business_tz(db, business_id)
    start, end = _window(days, tz)
    rows = await db.sales.aggregate([
        {"$match": {"business_id": business_id, "status": "completed", "created_at": {"$gte": start, "$lt": end}}},
        {"$unwind": "$items"},
        {"$group": {
            "_id": "$items.product_id",
            "name": {"$first": "$items.name"},
            "quantity_sold": {"$sum": "$items.quantity"},
            "revenue": {"$sum": "$items.line_total"},
            "cost": {"$sum": {"$multiply": ["$items.quantity", {"$ifNull": ["$items.unit_cost", 0]}]}},
        }},
    ]).to_list(None)
    for r in rows:
        r["profit"] = r["revenue"] - r["cost"]
    key = "profit" if (is_owner and sort == "profit") else "quantity_sold"
    ranked = sorted(rows, key=lambda r: (-r[key], r["name"]))[:limit]

    out = []
    for r in ranked:
        item = {"product_id": r["_id"], "name": r["name"], "quantity_sold": round(r["quantity_sold"], 3)}
        if is_owner:
            item["revenue"] = rules.money(r["revenue"])
            item["profit"] = rules.money(r["profit"])
        out.append(item)

    result = {"days": days, "period_start": start, "period_end": end, "sorted_by": key, "winners": out}
    if is_owner:
        sold_ids = [r["_id"] for r in rows]
        dormant = [
            {"product_id": p["id"], "name": p["name"], "quantity": p["quantity"],
             "immobilized": rules.money(p["quantity"] * p["purchase_price"])}
            async for p in db.products.find(
                {"business_id": business_id, "is_archived": False, "quantity": {"$gt": 0},
                 "purchase_price": {"$gt": 0}, "id": {"$nin": sold_ids}, "created_at": {"$lte": start}},
                {"_id": 0, "id": 1, "name": 1, "quantity": 1, "purchase_price": 1},
            )
        ]
        dormant.sort(key=lambda d: -d["immobilized"])
        result["dormant"] = dormant[:5]
    return result


@router.get("/stock/suggestions")
async def suggestions(
    days: int = Query(30, ge=7, le=90),
    cover_days: int = Query(14, ge=1, le=90),
    user: dict = Depends(require_owner),
    db=Depends(get_db),
):
    """Quoi racheter, en quelle quantité, et ce que le fonds de réappro permet d'acheter. Propriétaire uniquement."""
    business_id = user["business_id"]
    tz = await business_tz(db, business_id)
    start, end = _window(days, tz)
    business = await db.businesses.find_one({"id": business_id}, {"_id": 0, "settings": 1}) or {}
    cfg = {**DEFAULT_SETTINGS, **(business.get("settings") or {})}
    fund = await _fund_state(db, business_id)
    sold = await _sold_by_product(db, business_id, start, end)
    products = [p async for p in db.products.find({"business_id": business_id, "is_archived": False}, {"_id": 0})]
    result = rules.build_suggestions(
        products, sold, utcnow(), days=days, cover_days=cover_days,
        alert_days=int(cfg["forecast_alert_days"]), budget=fund["reappro_budget"] if fund["started"] else None,
    )
    return {"started": fund["started"], "budget": fund["reappro_budget"] if fund["started"] else None,
            "days": days, "cover_days": cover_days, **result}


@router.post("/stock/purchase-order/pdf")
async def purchase_order(body: PurchaseOrderIn, user: dict = Depends(require_owner), db=Depends(get_db)):
    """Bon de commande PDF pour un fournisseur : produits, quantités, prix d'achat, total. Rien n'est enregistré."""
    business_id = user["business_id"]
    quantities: dict[str, float] = {}
    for line in body.lines:  # lignes en double regroupées
        quantities[line.product_id] = quantities.get(line.product_id, 0) + line.quantity
    products = {
        p["id"]: p
        async for p in db.products.find({"business_id": business_id, "id": {"$in": list(quantities)}}, {"_id": 0})
    }
    lines = []
    for product_id, quantity in quantities.items():
        product = products.get(product_id)
        if product is None:
            raise HTTPException(404, "Un produit du bon de commande est introuvable.")
        if product["is_archived"]:
            raise HTTPException(400, f"« {product['name']} » est archivé.")
        cost = float(product.get("purchase_price") or 0)
        lines.append({"name": product["name"], "code": product.get("code") or "", "unit": product.get("unit") or "",
                      "quantity": quantity, "unit_cost": cost, "line_total": round(cost * quantity, 2)})
    lines.sort(key=lambda l: l["name"].lower())
    business = await db.businesses.find_one({"id": business_id}, {"_id": 0})
    now = utcnow()
    number = f"BC-{now.astimezone(tz_of(business)):%Y%m%d-%H%M}"
    pdf = purchase_order_pdf(business, (body.supplier or "").strip() or None, lines, number, now)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="bon-de-commande-{number}.pdf"'})
