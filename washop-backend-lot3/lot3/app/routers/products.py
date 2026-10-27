"""Routes des produits : codes (code-barres ou QR), modifications tracées, archivage, stock."""
import datetime as dt
import re
import secrets
import uuid
from io import BytesIO
from typing import Optional

import qrcode
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response
from pymongo.errors import DuplicateKeyError

from ..db import get_db, run_transaction
from ..errors import AppError
from ..schemas import MotifIn, ProductCreate, ProductUpdate, QrSheetIn, StockAdjustIn, product_out
from ..security import get_current_user, require_owner
from ..services.audit import audit_entry, check_motif, write_audit
from ..services.pdf import qr_sheet_pdf
from ..services.stock import apply_stock_delta, build_movement, start_of_day, utcnow

router = APIRouter(tags=["products"])

_QR_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
PRICE_FIELDS = ("sale_price", "purchase_price")
# Champs tracés par « product_updated » (sans motif). Les prix restent tracés par « product_price_changed ».
TRACKED_FIELDS = ("name", "description", "category", "unit", "expiry_date", "low_stock_threshold", "supplier")


def _code_filter(business_id: str, code: str) -> dict:
    """Produit actif portant ce code. qr_code couvre les produits pas encore migrés."""
    return {"business_id": business_id, "is_archived": False, "$or": [{"code": code}, {"qr_code": code}]}


async def _new_qr_code(db, business_id: str) -> str:
    """Identifiant non devinable (wsp_ + 12 caractères), généré une fois."""
    while True:
        code = "wsp_" + "".join(secrets.choice(_QR_ALPHABET) for _ in range(12))
        if not await db.products.find_one({"business_id": business_id, "$or": [{"code": code}, {"qr_code": code}]}, {"_id": 1}):
            return code


async def _raise_if_code_taken(db, business_id: str, code: str) -> None:
    existing = await db.products.find_one(_code_filter(business_id, code), {"_id": 0, "id": 1, "name": 1})
    if existing:
        raise AppError(
            409, f"Un produit existe déjà avec ce code : « {existing['name']} ». Ajoutez plutôt du stock.",
            code="PRODUCT_EXISTS", product_id=existing["id"],
        )


async def _get_product(db, business_id: str, product_id: str, session=None) -> dict:
    product = await db.products.find_one({"id": product_id, "business_id": business_id}, {"_id": 0}, session=session)
    if product is None:
        raise HTTPException(404, "Produit introuvable.")
    return product


@router.post("/products", status_code=201)
async def create_product(body: ProductCreate, user: dict = Depends(get_current_user), db=Depends(get_db)):
    """Patron et caissier. Code-barres saisi ou scanné (barcode), ou QR généré (qr). 409 PRODUCT_EXISTS si le code existe."""
    business_id = user["business_id"]
    supplier = (body.supplier or "").strip() or None
    if supplier and user["role"] != "owner":
        raise AppError(403, "Le fournisseur est réservé au patron.")
    code = body.code if body.code_type == "barcode" else await _new_qr_code(db, business_id)
    await _raise_if_code_taken(db, business_id, code)

    now = utcnow()
    product_id = str(uuid.uuid4())
    initial = round(body.initial_quantity, 3)
    product = {
        "id": product_id,
        "business_id": business_id,
        "name": body.name.strip(),
        "description": body.description,
        "category": body.category,
        "unit": body.unit,
        "sale_price": body.sale_price,
        "purchase_price": body.purchase_price,
        "supplier": supplier,
        "quantity": initial,
        "low_stock_threshold": body.low_stock_threshold,
        "expiry_date": start_of_day(body.expiry_date) if body.expiry_date else None,
        "code": code,
        "code_type": body.code_type,
        "qr_code": code,  # le QR imprimable encode toujours le code du produit
        "is_archived": False,
        "deleted_at": None,
        "deleted_by": None,
        "created_by": user["id"],
        "created_at": now,
        "updated_at": now,
    }

    async def _txn(s):
        await db.products.insert_one(dict(product), session=s)
        await db.stock_movements.insert_one(build_movement(
            business_id=business_id, product_id=product_id, movement_type="initial",
            quantity_change=initial, quantity_after=initial, created_by=user["id"],
        ), session=s)
        await write_audit(db, audit_entry(
            user, "product_created", "product", product_id,
            new_value={"name": product["name"], "code": code, "code_type": body.code_type,
                       "sale_price": body.sale_price, "quantity": initial},
            product_ids=[product_id],
        ), session=s)

    try:
        await run_transaction(db, _txn)
    except DuplicateKeyError:
        await _raise_if_code_taken(db, business_id, code)  # créé entre-temps par une autre requête
        raise
    return product_out(product, user["role"])


@router.get("/products")
async def list_products(
    q: Optional[str] = None,
    category: Optional[str] = None,
    low_stock: bool = False,
    expiring: bool = False,
    include_archived: bool = False,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: dict = Depends(get_current_user),
    db=Depends(get_db),
):
    business_id = user["business_id"]
    flt: dict = {"business_id": business_id}
    if not (include_archived and user["role"] == "owner"):
        flt["is_archived"] = False
    if q:
        # Nom OU code (code-barres ou QR), insensible à la casse
        pattern = {"$regex": re.escape(q.strip()), "$options": "i"}
        flt["$or"] = [{"name": pattern}, {"code": pattern}, {"qr_code": pattern}]
    if category:
        flt["category"] = category
    if low_stock or expiring:
        settings = (await db.businesses.find_one({"id": business_id}))["settings"]
    if low_stock:
        flt["$expr"] = {"$lte": ["$quantity", {"$ifNull": ["$low_stock_threshold", settings["low_stock_default_threshold"]]}]}
    if expiring:
        flt["expiry_date"] = {"$lte": utcnow() + dt.timedelta(days=settings["expiry_alert_days"])}

    total = await db.products.count_documents(flt)
    cursor = db.products.find(flt, {"_id": 0}).sort("name", 1).skip((page - 1) * page_size).limit(page_size)
    items = [product_out(p, user["role"]) async for p in cursor]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/products/by-code/{code}")
async def product_by_code(code: str, user: dict = Depends(get_current_user), db=Depends(get_db)):
    """Recherche par code (code-barres ou QR), limitée au commerce du jeton, sans produits archivés."""
    product = await db.products.find_one(_code_filter(user["business_id"], code), {"_id": 0})
    if product is None:
        raise HTTPException(404, "Aucun produit ne correspond à ce code.")
    return product_out(product, user["role"])


@router.get("/products/{product_id}")
async def get_product(product_id: str, user: dict = Depends(get_current_user), db=Depends(get_db)):
    return product_out(await _get_product(db, user["business_id"], product_id), user["role"])


@router.put("/products/{product_id}")
@router.patch("/products/{product_id}")
async def update_product(product_id: str, body: ProductUpdate, user: dict = Depends(get_current_user), db=Depends(get_db)):
    """
    PUT (existant) et PATCH : même comportement. Caissier : motif obligatoire pour changer le prix de vente,
    et pas d'accès au prix d'achat. Tout autre champ modifié est tracé par « product_updated », sans motif.
    Le changement et ses lignes de journal sont écrits dans la même transaction.
    """
    business_id = user["business_id"]
    changes = body.model_dump(exclude_unset=True, exclude={"motif_code", "motif_note"})
    for key in ("name", "unit", "sale_price", "purchase_price"):
        if key in changes and changes[key] is None:
            changes.pop(key)  # champs obligatoires : un null ne les efface pas
    if user["role"] != "owner" and "purchase_price" in changes:
        raise AppError(403, "Le prix d'achat est réservé au patron.")
    if user["role"] != "owner" and "supplier" in changes:
        raise AppError(403, "Le fournisseur est réservé au patron.")
    if "supplier" in changes:
        changes["supplier"] = (changes["supplier"] or "").strip() or None
    if "expiry_date" in changes:
        changes["expiry_date"] = start_of_day(changes["expiry_date"]) if changes["expiry_date"] else None
    if changes.get("name"):
        changes["name"] = changes["name"].strip()

    async def _txn(s):
        product = await _get_product(db, business_id, product_id, session=s)
        if product["is_archived"]:
            raise HTTPException(400, "Produit archivé : modification impossible.")
        changed_prices = [k for k in PRICE_FIELDS if k in changes and changes[k] != product.get(k)]
        # Seuls les champs dont la valeur change réellement sont écrits dans le journal.
        changed_fields = [k for k in TRACKED_FIELDS if k in changes and changes[k] != product.get(k)]
        motif_code, motif_note = (None, None)
        if changed_prices:
            motif_code, motif_note = check_motif(user, body.motif_code, body.motif_note)
        await db.products.update_one(
            {"id": product_id, "business_id": business_id}, {"$set": {**changes, "updated_at": utcnow()}}, session=s
        )
        if changed_prices:
            # Les ventes passées gardent leur copie du prix : rien d'autre à modifier.
            await write_audit(db, audit_entry(
                user, "product_price_changed", "product", product_id,
                old_value={k: product.get(k) for k in changed_prices},
                new_value={k: changes[k] for k in changed_prices},
                motif_code=motif_code, motif_note=motif_note, product_ids=[product_id],
            ), session=s)
        if changed_fields:
            await write_audit(db, audit_entry(
                user, "product_updated", "product", product_id,
                old_value={k: product.get(k) for k in changed_fields},
                new_value={k: changes[k] for k in changed_fields},
                product_ids=[product_id],
            ), session=s)
        return await _get_product(db, business_id, product_id, session=s)

    updated = await run_transaction(db, _txn)
    return product_out(updated, user["role"])


@router.delete("/products/{product_id}")
async def archive_product(
    product_id: str,
    body: Optional[MotifIn] = Body(default=None),
    motif_code: Optional[str] = Query(default=None),
    motif_note: Optional[str] = Query(default=None, max_length=500),
    user: dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Archive (jamais de suppression physique) : l'historique des ventes reste intact.
    Caissier : motif obligatoire, dans le corps JSON ou en paramètres de requête.
    """
    business_id = user["business_id"]
    code = body.motif_code if body and body.motif_code else motif_code
    note = body.motif_note if body and body.motif_note else motif_note
    if code is not None and code not in ("erreur_de_saisie", "client_a_change_avis", "produit_abime", "autre"):
        raise AppError(400, f"Motif inconnu : {code}.", code="MOTIF_REQUIRED")

    async def _txn(s):
        product = await _get_product(db, business_id, product_id, session=s)
        if product["is_archived"]:
            return product
        m_code, m_note = check_motif(user, code, note)
        now = utcnow()
        await db.products.update_one(
            {"id": product_id, "business_id": business_id},
            {"$set": {"is_archived": True, "deleted_at": now, "deleted_by": user["id"], "updated_at": now}},
            session=s,
        )
        await write_audit(db, audit_entry(
            user, "product_archived", "product", product_id,
            old_value={"is_archived": False}, new_value={"is_archived": True},
            motif_code=m_code, motif_note=m_note, product_ids=[product_id],
        ), session=s)
        return await _get_product(db, business_id, product_id, session=s)

    archived = await run_transaction(db, _txn)
    return product_out(archived, user["role"])


@router.post("/products/{product_id}/stock")
async def adjust_stock(product_id: str, body: StockAdjustIn, user: dict = Depends(get_current_user), db=Depends(get_db)):
    """
    Stock + mouvement + journal dans UNE transaction.
    Caissier : réapprovisionnement (positif) uniquement. Corrections : patron uniquement.
    """
    business_id = user["business_id"]
    if user["role"] != "owner" and body.type != "restock":
        raise AppError(403, "Correction de stock réservée au patron.")
    if body.type == "restock" and body.quantity_change < 0:
        raise HTTPException(400, "Un réapprovisionnement doit être une quantité positive.")
    delta = round(body.quantity_change, 3)

    async def _txn(s):
        product = await _get_product(db, business_id, product_id, session=s)
        if product["is_archived"]:
            raise HTTPException(400, "Produit archivé : stock non modifiable.")
        updated = await apply_stock_delta(db, business_id, product_id, delta, session=s)
        if updated is None:
            raise HTTPException(409, f"Stock insuffisant pour « {product['name']} » : {product['quantity']:g} disponible(s).")
        # Coût d'achat du réapprovisionnement : saisi par le patron, sinon prix d'achat actuel (un caissier ne le voit pas).
        unit_cost = None
        if body.type == "restock":
            unit_cost = body.unit_cost if (user["role"] == "owner" and body.unit_cost is not None) else product.get("purchase_price")
        await db.stock_movements.insert_one(build_movement(
            business_id=business_id, product_id=product_id, movement_type=body.type,
            quantity_change=delta, quantity_after=updated["quantity"], created_by=user["id"], reason=body.reason,
            unit_cost=unit_cost,
        ), session=s)
        await write_audit(db, audit_entry(
            user, "product_stock_adjusted", "product", product_id,
            old_value={"quantity": product["quantity"]},
            new_value={"quantity": updated["quantity"], "type": body.type, "reason": body.reason,
                       **({"unit_cost": unit_cost} if unit_cost is not None else {})},
            product_ids=[product_id],
        ), session=s)
        return updated

    updated = await run_transaction(db, _txn)
    return product_out(updated, user["role"])


@router.get("/products/{product_id}/movements")
async def product_movements(
    product_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: dict = Depends(require_owner),
    db=Depends(get_db),
):
    business_id = user["business_id"]
    await _get_product(db, business_id, product_id)
    flt = {"business_id": business_id, "product_id": product_id}
    total = await db.stock_movements.count_documents(flt)
    cursor = (
        db.stock_movements.find(flt, {"_id": 0, "business_id": 0})
        .sort("created_at", -1).skip((page - 1) * page_size).limit(page_size)
    )
    items = [m async for m in cursor]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/products/{product_id}/qr")
async def product_qr_png(product_id: str, user: dict = Depends(get_current_user), db=Depends(get_db)):
    product = await _get_product(db, user["business_id"], product_id)
    buf = BytesIO()
    qrcode.make(product["qr_code"]).save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@router.post("/products/qr-sheet")
async def qr_sheet(body: QrSheetIn, user: dict = Depends(get_current_user), db=Depends(get_db)):
    """Planche A4 de QR codes, dans l'ordre demandé."""
    found = {
        p["id"]: p
        async for p in db.products.find(
            {"business_id": user["business_id"], "id": {"$in": body.product_ids}, "is_archived": False},
            {"_id": 0, "id": 1, "name": 1, "qr_code": 1},
        )
    }
    ordered = [found[pid] for pid in body.product_ids if pid in found]
    if not ordered:
        raise HTTPException(404, "Aucun produit actif trouvé pour cette planche.")
    pdf = qr_sheet_pdf([(p["name"], p["qr_code"]) for p in ordered])
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": 'inline; filename="planche-qr.pdf"'})
