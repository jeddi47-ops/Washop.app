"""Caisse et ventes : création, annulation et reçu. Chaque écriture (et sa ligne de journal) est UNE transaction MongoDB."""
import datetime as dt
import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from ..db import get_db, run_transaction
from ..schemas import CancelIn, SaleCreateIn, sale_out
from ..security import get_current_user
from ..services.audit import audit_entry, check_motif, write_audit
from ..services.pdf import invoice_pdf
from ..services.stock import apply_stock_delta, build_movement, start_of_day, utcnow
from ..services.timezones import business_tz, local_midnight_utc

router = APIRouter(tags=["sales"])

CENT = Decimal("0.01")


def _fmt_qty(value: float) -> str:
    return f"{value:g}"


async def _last_own_sale(db, user: dict) -> dict | None:
    """Dernière vente faite par ce caissier : c'est le seul reçu qu'il peut revoir."""
    return await db.sales.find_one(
        {"business_id": user["business_id"], "created_by": user["id"]}, {"_id": 0}, sort=[("created_at", -1)]
    )


async def _visible_sale(db, user: dict, sale_id: str) -> dict:
    """Patron : toutes les ventes du commerce. Caissier : uniquement le reçu de sa dernière vente."""
    if user["role"] == "owner":
        sale = await db.sales.find_one({"id": sale_id, "business_id": user["business_id"]}, {"_id": 0})
    else:
        last = await _last_own_sale(db, user)
        sale = last if last and last["id"] == sale_id else None
    if sale is None:
        raise HTTPException(404, "Vente introuvable.")
    return sale


async def _sale_by_client_id(db, business_id: str, client_sale_id: str) -> dict | None:
    return await db.sales.find_one({"business_id": business_id, "client_sale_id": client_sale_id}, {"_id": 0})


async def _insert_movements(db, session, movements: list[dict]) -> None:
    """Insertion des mouvements de stock. Point unique d'injection de panne pour les tests."""
    if movements:
        await db.stock_movements.insert_many(movements, session=session)


@router.post("/sales", status_code=201)
async def create_sale(body: SaleCreateIn, user: dict = Depends(get_current_user), db=Depends(get_db)):
    """
    Règle 5.3 en UNE transaction MongoDB :
    décréments conditionnels (quantity >= demandé), compteur de facture ($inc dans la transaction),
    vente et mouvements. Une erreur à n'importe quelle étape annule tout : stock, compteur et vente.
    Un stock insuffisant refuse toute la vente (409).
    """
    business_id = user["business_id"]
    client_sale_id = (body.client_sale_id or "").strip() or None

    # Même identifiant de paiement déjà enregistré : on renvoie la vente existante, sans rien décrémenter.
    if client_sale_id:
        existing = await _sale_by_client_id(db, business_id, client_sale_id)
        if existing is not None:
            return sale_out(existing, user["role"])

    # Lignes en double regroupées (même produit deux fois dans le panier).
    lines: dict[str, float] = {}
    scanned: dict[str, str] = {}
    for line in body.items:
        lines[line.product_id] = lines.get(line.product_id, 0) + line.quantity
        if line.scanned_code and line.product_id not in scanned:
            scanned[line.product_id] = line.scanned_code.strip()

    async def _txn(session):
        # Rejouée automatiquement en cas de conflit : tout l'état est donc construit ici, dans la transaction.
        now = utcnow()
        products = {
            p["id"]: p
            async for p in db.products.find(
                {"business_id": business_id, "id": {"$in": list(lines)}}, {"_id": 0}, session=session
            )
        }
        for product_id in lines:
            product = products.get(product_id)
            if product is None:
                raise HTTPException(404, "Un produit du panier est introuvable.")
            if product["is_archived"]:
                raise HTTPException(400, f"« {product['name']} » est archivé et ne peut pas être vendu.")

        # Décrément conditionnel sur chaque ligne. Une ligne en rupture refuse toute la vente.
        after: dict[str, float] = {}
        for product_id, qty in lines.items():
            updated = await apply_stock_delta(db, business_id, product_id, -qty, session=session)
            if updated is None:
                current = await db.products.find_one(
                    {"id": product_id, "business_id": business_id}, {"_id": 0, "name": 1, "quantity": 1}, session=session
                )
                raise HTTPException(
                    409,
                    f"Stock insuffisant pour « {current['name']} » : {_fmt_qty(current['quantity'])} disponible(s). "
                    "Retirez ce produit du panier pour continuer.",
                )
            after[product_id] = updated["quantity"]

        # Totaux avec les prix du moment de la vente (règle 5.3, copies dans les lignes).
        items, total, total_cost = [], Decimal("0"), Decimal("0")
        for product_id, qty in lines.items():
            product = products[product_id]
            price = Decimal(str(product["sale_price"]))
            cost = Decimal(str(product.get("purchase_price") or 0))
            qty_d = Decimal(str(qty))
            line_total = (price * qty_d).quantize(CENT, ROUND_HALF_UP)
            total += line_total
            total_cost += (cost * qty_d).quantize(CENT, ROUND_HALF_UP)
            items.append({
                "product_id": product_id,
                "name": product["name"],
                "unit_price": float(price),
                "unit_cost": float(cost),
                "quantity": qty,
                "line_total": float(line_total),
                "code": scanned.get(product_id) or product.get("code") or product.get("qr_code"),  # code scanné
            })
        profit = total - total_cost

        change = None
        received = body.amount_received
        if body.payment_method == "cash" and received is not None:
            if Decimal(str(received)) < total:
                raise HTTPException(400, "Le montant reçu est inférieur au total de la vente.")
            change = float((Decimal(str(received)) - total).quantize(CENT, ROUND_HALF_UP))

        # Numéro de facture : compteur incrémenté DANS la transaction, donc jamais de trou ni de doublon.
        counter = await db.businesses.find_one_and_update(
            {"id": business_id},
            {"$inc": {"invoice_counter": 1}},
            return_document=ReturnDocument.AFTER,
            projection={"invoice_counter": 1},
            session=session,
        )
        sale_id = str(uuid.uuid4())
        sale = {
            "id": sale_id,
            "business_id": business_id,
            "client_sale_id": client_sale_id,
            "number": f"F-{counter['invoice_counter']:06d}",
            "items": items,
            "total": float(total),
            "total_cost": float(total_cost),
            "profit": float(profit),
            "payment_method": body.payment_method,
            "amount_received": received,
            "change_given": change,
            "status": "completed",
            "cancelled_at": None,
            "cancel_reason": None,
            "cancelled_by": None,
            "created_by": user["id"],
            "cashier_id": user["id"],
            "cashier_name": user.get("name"),
            "session_id": user.get("session_id"),
            "device_type": user.get("device_type"),
            "customer_id": None,  # fiches clients : lot suivant
            "created_at": now,
        }
        await db.sales.insert_one(sale, session=session)

        movements = [
            build_movement(
                business_id=business_id, product_id=product_id, movement_type="sale",
                quantity_change=-qty, quantity_after=after[product_id],
                created_by=user["id"], sale_id=sale_id,
            )
            for product_id, qty in lines.items()
        ]
        await _insert_movements(db, session, movements)
        await write_audit(db, audit_entry(
            user, "sale_created", "sale", sale_id,
            new_value={"number": sale["number"], "total": sale["total"], "payment_method": body.payment_method,
                       "items": [{"product_id": i["product_id"], "quantity": i["quantity"], "unit_price": i["unit_price"]} for i in items]},
            product_ids=list(lines),
        ), session=session)
        return sale

    try:
        sale = await run_transaction(db, _txn)
    except DuplicateKeyError:
        # Deux envois simultanés avec le même identifiant : le second perd la course et reçoit la vente du premier.
        existing = await _sale_by_client_id(db, business_id, client_sale_id) if client_sale_id else None
        if existing is None:
            raise
        return sale_out(existing, user["role"])
    return sale_out(sale, user["role"])


@router.get("/sales")
async def list_sales(
    date_from: Optional[dt.date] = None,
    date_to: Optional[dt.date] = None,
    status: Optional[Literal["completed", "cancelled"]] = None,
    cashier_id: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: dict = Depends(get_current_user),
    db=Depends(get_db),
):
    business_id = user["business_id"]
    if user["role"] != "owner":
        # Caissier : pas d'historique, seulement le reçu de sa dernière vente (filtres ignorés).
        last = await _last_own_sale(db, user)
        items = [sale_out(last, user["role"])] if last else []
        return {"items": items, "total": len(items), "page": 1, "page_size": page_size}
    flt: dict = {"business_id": business_id}
    if status:
        flt["status"] = status
    if cashier_id:
        flt["cashier_id"] = cashier_id  # filtre du patron ; le caissier ne voit que son dernier reçu (ci-dessus)
    tz = await business_tz(db, business_id)
    rng = {}
    if date_from:
        rng["$gte"] = local_midnight_utc(date_from, tz)  # jours découpés dans le fuseau du commerce
    if date_to:
        rng["$lt"] = local_midnight_utc(date_to + dt.timedelta(days=1), tz)
    if rng:
        flt["created_at"] = rng

    total = await db.sales.count_documents(flt)
    cursor = db.sales.find(flt, {"_id": 0}).sort("created_at", -1).skip((page - 1) * page_size).limit(page_size)
    items = [sale_out(s, user["role"]) async for s in cursor]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/sales/{sale_id}")
async def get_sale(sale_id: str, user: dict = Depends(get_current_user), db=Depends(get_db)):
    return sale_out(await _visible_sale(db, user, sale_id), user["role"])


@router.post("/sales/{sale_id}/cancel")
async def cancel_sale(
    sale_id: str, body: Optional[CancelIn] = None, user: dict = Depends(get_current_user), db=Depends(get_db)
):
    """
    UNE transaction : passage en 'cancelled' (condition atomique, donc une seule fois), remise en stock,
    mouvements 'sale_cancel' et ligne de journal. Deux annulations simultanées : une seule réussit.
    Caissier : motif obligatoire, et seulement sur ses propres ventes.
    """
    business_id = user["business_id"]
    motif_code, motif_note = check_motif(user, body.motif_code if body else None, body.motif_note if body else None)
    reason = (body.reason if body else None) or motif_note or motif_code
    scope = {"id": sale_id, "business_id": business_id}
    if user["role"] != "owner":
        scope["created_by"] = user["id"]

    async def _txn(session):
        sale = await db.sales.find_one_and_update(
            {**scope, "status": "completed"},
            {"$set": {"status": "cancelled", "cancelled_at": utcnow(), "cancel_reason": reason, "cancelled_by": user["id"]}},
            return_document=ReturnDocument.AFTER,
            projection={"_id": 0},
            session=session,
        )
        if sale is None:
            exists = await db.sales.find_one(scope, {"_id": 1}, session=session)
            if exists is None:
                raise HTTPException(404, "Vente introuvable.")
            raise HTTPException(409, "Cette vente est déjà annulée.")

        movements = []
        for line in sale["items"]:
            updated = await apply_stock_delta(db, business_id, line["product_id"], line["quantity"], session=session)
            if updated is None:
                raise RuntimeError("Produit introuvable pendant l'annulation de la vente.")
            movements.append(build_movement(
                business_id=business_id, product_id=line["product_id"], movement_type="sale_cancel",
                quantity_change=line["quantity"], quantity_after=updated["quantity"],
                created_by=user["id"], sale_id=sale_id,
            ))
        await _insert_movements(db, session, movements)
        await write_audit(db, audit_entry(
            user, "sale_cancelled", "sale", sale_id,
            old_value={"status": "completed"}, new_value={"status": "cancelled", "number": sale["number"], "total": sale["total"]},
            motif_code=motif_code, motif_note=motif_note, product_ids=[l["product_id"] for l in sale["items"]],
        ), session=session)
        return sale

    sale = await run_transaction(db, _txn)
    return sale_out(sale, user["role"])


@router.get("/sales/{sale_id}/invoice")
async def sale_invoice(sale_id: str, user: dict = Depends(get_current_user), db=Depends(get_db)):
    business_id = user["business_id"]
    sale = await _visible_sale(db, user, sale_id)
    business = await db.businesses.find_one({"id": business_id}, {"_id": 0})
    pdf = invoice_pdf(business, sale)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="facture-{sale["number"]}.pdf"'})
