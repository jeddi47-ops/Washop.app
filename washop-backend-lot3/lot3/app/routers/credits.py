"""
Crédits clients. Le crédit est CRÉÉ par POST /api/sales (payment_method = "credit"), dans la même transaction que la vente.
Ici : consulter les crédits et enregistrer les remboursements du client.

Droits : propriétaire et caissier peuvent consulter et encaisser un remboursement.
Le caissier ne voit jamais le numéro de pièce d'identité en entier. Le résumé chiffré est réservé au propriétaire.
"""
import re
import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pymongo import ReturnDocument

from ..db import get_db, run_transaction
from ..schemas import CreditPaymentIn
from ..security import get_current_user, require_owner
from ..services import credit as rules
from ..services.audit import audit_entry, write_audit
from ..services.stock import utcnow
from ..services.timezones import local_midnight_utc, local_today, tz_of

router = APIRouter(tags=["credits"])

CENT = Decimal("0.01")
MAX_OPEN_SCAN = 1000  # nombre maximum de crédits en cours lus pour calculer retards et résumé


async def _business(db, business_id: str) -> dict:
    return await db.businesses.find_one({"id": business_id}, {"_id": 0, "currency": 1, "timezone": 1, "settings": 1}) or {}


def credit_out(credit: dict, role: str, today) -> dict:
    out = rules.view(credit, today)
    out.pop("customer_id_key", None)  # clé interne de comparaison : ce serait le numéro en clair
    if role != "owner":
        out["customer_id_number"] = rules.mask_id(out.get("customer_id_number"))
        out.pop("limit_override", None)  # montants et nom du propriétaire : pas pour le caissier
    return out


@router.get("/credits/summary")
async def credits_summary(user: dict = Depends(require_owner), db=Depends(get_db)):
    """
    Propriétaire : les chiffres des créances.
    outstanding = ce que les clients doivent ; overdue = en retard ; due_week = à payer dans les 7 jours ;
    collected_month = remboursements encaissés depuis le début du mois (les acomptes ne comptent pas : ils sont payés à la vente).
    """
    business_id = user["business_id"]
    business = await _business(db, business_id)
    tz = tz_of(business)
    today = local_today(tz)
    docs = await db.credits.find({"business_id": business_id, "status": "open"}, {"_id": 0}).limit(MAX_OPEN_SCAN).to_list(MAX_OPEN_SCAN)
    outstanding = overdue = due_week = 0.0
    late_count = week_count = 0
    for doc in docs:
        v = rules.view(doc, today)
        outstanding += v["balance"]
        overdue += v["overdue_amount"]
        due_week += v["due_week_amount"]
        late_count += 1 if v["is_overdue"] else 0
        week_count += 1 if v["due_week_amount"] > 0 else 0

    month_start = local_midnight_utc(today.replace(day=1), tz)
    collected = 0.0
    async for doc in db.credits.find(
        {"business_id": business_id, "payments.created_at": {"$gte": month_start}}, {"_id": 0, "payments": 1}
    ).limit(5000):
        collected += sum(p["amount"] for p in doc.get("payments", []) if p["created_at"] >= month_start)
    # Vendu à crédit aujourd'hui : compté dans « Ventes du jour » mais pas encore dans la caisse (total dû moins acompte).
    today_start = local_midnight_utc(today, tz)
    lent_today = 0.0
    async for doc in db.credits.find(
        {"business_id": business_id, "created_at": {"$gte": today_start}, "status": {"$ne": "cancelled"}},
        {"_id": 0, "total_due": 1, "down_payment": 1},
    ).limit(5000):
        lent_today += doc["total_due"] - doc["down_payment"]
    return {
        "outstanding": round(outstanding, 2),
        "overdue_amount": round(overdue, 2),
        "due_week_amount": round(due_week, 2),
        "collected_month": round(collected, 2),
        "credit_today": round(lent_today, 2),
        "open_count": len(docs),
        "late_count": late_count,
        "due_week_count": week_count,
    }


@router.get("/credits/check")
async def check_customer(
    id_number: str = Query(min_length=3, max_length=40),
    user: dict = Depends(get_current_user),
    db=Depends(get_db),
):
    """
    Avant de valider un crédit : ce que ce client (même numéro de pièce d'identité) doit déjà, et s'il est en retard.
    Sert à avertir le caissier. Ne renvoie ni le numéro ni le téléphone.
    """
    business_id = user["business_id"]
    business = await _business(db, business_id)
    today = local_today(tz_of(business))
    key = rules.id_key(id_number)
    docs = []
    if len(key) >= 3:
        docs = await db.credits.find(
            {"business_id": business_id, "customer_id_key": key, "status": "open"}, {"_id": 0}
        ).limit(200).to_list(200)
    views = [rules.view(d, today) for d in docs]
    debt = sum(v["balance"] for v in views)
    overdue = sum(v["overdue_amount"] for v in views)
    names = sorted({v["customer_name"] for v in views})[:3]
    max_debt = float((business.get("settings") or {}).get("credit_max_debt") or 0)
    return {
        "found": bool(views),
        "open_count": len(views),
        "current_debt": round(debt, 2),
        "overdue_amount": round(overdue, 2),
        "names": names,
        "max_debt": max_debt,
        "available": max(0.0, round(max_debt - debt, 2)) if max_debt > 0 else None,
    }


@router.get("/credits")
async def list_credits(
    status: Literal["open", "late", "week", "paid", "cancelled", "all"] = "open",
    q: Optional[str] = Query(default=None, max_length=60),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: dict = Depends(get_current_user),
    db=Depends(get_db),
):
    business_id = user["business_id"]
    today = local_today(tz_of(await _business(db, business_id)))
    flt: dict = {"business_id": business_id}
    if q and q.strip():
        pattern = {"$regex": re.escape(q.strip()), "$options": "i"}
        flt["$or"] = [{"customer_name": pattern}, {"customer_phone": pattern}, {"sale_number": pattern}]

    if status in ("open", "late", "week"):
        flt["status"] = "open"
        docs = await db.credits.find(flt, {"_id": 0}).sort("created_at", 1).limit(MAX_OPEN_SCAN).to_list(MAX_OPEN_SCAN)
        items = [credit_out(d, user["role"], today) for d in docs]
        if status == "late":
            items = [i for i in items if i["is_overdue"]]
        elif status == "week":
            items = [i for i in items if i["due_week_amount"] > 0]
        # En retard d'abord, puis par date d'échéance la plus proche.
        items.sort(key=lambda i: (not i["is_overdue"], (i["next_due"] or {}).get("due_date", "9999-12-31")))
        total = len(items)
        start = (page - 1) * page_size
        items = items[start:start + page_size]
    else:
        if status in ("paid", "cancelled"):
            flt["status"] = status
        total = await db.credits.count_documents(flt)
        cursor = db.credits.find(flt, {"_id": 0}).sort("created_at", -1).skip((page - 1) * page_size).limit(page_size)
        items = [credit_out(d, user["role"], today) async for d in cursor]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/credits/{credit_id}")
async def get_credit(credit_id: str, user: dict = Depends(get_current_user), db=Depends(get_db)):
    business_id = user["business_id"]
    credit = await db.credits.find_one({"id": credit_id, "business_id": business_id}, {"_id": 0})
    if credit is None:
        raise HTTPException(404, "Crédit introuvable.")
    today = local_today(tz_of(await _business(db, business_id)))
    return credit_out(credit, user["role"], today)


@router.post("/credits/{credit_id}/payments", status_code=201)
async def add_payment(credit_id: str, body: CreditPaymentIn, user: dict = Depends(get_current_user), db=Depends(get_db)):
    """
    Enregistre un remboursement du client. UNE transaction : lecture du crédit, contrôle du reste dû,
    ajout du paiement, mise à jour du reste et ligne de journal. Un même client_payment_id n'est enregistré qu'une fois.
    """
    business_id = user["business_id"]
    business = await _business(db, business_id)
    currency = business.get("currency") or "FC"
    amount = Decimal(str(body.amount)).quantize(CENT, ROUND_HALF_UP)
    if amount <= 0:
        raise HTTPException(400, "Le montant doit être supérieur à 0.")
    note = (body.note or "").strip() or None

    async def _txn(session):
        credit = await db.credits.find_one({"id": credit_id, "business_id": business_id}, {"_id": 0}, session=session)
        if credit is None:
            raise HTTPException(404, "Crédit introuvable.")
        payments = credit.get("payments") or []
        if body.client_payment_id and any(p.get("client_payment_id") == body.client_payment_id for p in payments):
            return credit  # même envoi répété (double clic, réseau) : rien n'est enregistré deux fois
        if credit["status"] == "paid":
            raise HTTPException(409, "Ce crédit est déjà soldé.")
        if credit["status"] == "cancelled":
            raise HTTPException(409, "Ce crédit est annulé.")

        repaid = sum((Decimal(str(p["amount"])) for p in payments), Decimal("0"))
        balance = Decimal(str(credit["total_due"])) - Decimal(str(credit["down_payment"])) - repaid
        if amount > balance:
            raise HTTPException(409, f"Le client ne doit plus que {rules.fmt_money(balance, currency)}.")
        new_balance = balance - amount
        now = utcnow()
        payment = {
            "id": str(uuid.uuid4()),
            "client_payment_id": body.client_payment_id,
            "amount": float(amount),
            "note": note,
            "created_at": now,
            "created_by": user["id"],
            "cashier_name": user.get("name"),
        }
        settled = new_balance <= 0
        updated = await db.credits.find_one_and_update(
            # Le statut a été contrôlé plus haut dans la même transaction : une écriture concurrente la ferait rejouer.
            {"id": credit_id, "business_id": business_id},
            {
                "$push": {"payments": payment},
                "$set": {
                    "balance": float(new_balance),
                    "status": "paid" if settled else "open",
                    "updated_at": now,
                    **({"paid_at": now} if settled else {}),
                },
            },
            return_document=ReturnDocument.AFTER,
            projection={"_id": 0},
            session=session,
        )
        if updated is None:
            raise HTTPException(409, "Ce crédit vient de changer. Recharge la page et réessaie.")
        await write_audit(db, audit_entry(
            user, "credit_payment_recorded", "credit", credit_id,
            old_value={"balance": float(balance)},
            new_value={"customer_name": credit["customer_name"], "sale_number": credit.get("sale_number"),
                       "amount": float(amount), "balance": float(new_balance)},
        ), session=session)
        return updated

    credit = await run_transaction(db, _txn)
    today = local_today(tz_of(business))
    return credit_out(credit, user["role"], today)
