"""Journal d'audit : lecture seule, patron uniquement. Aucune route de modification ni de suppression."""
import datetime as dt
from typing import Optional

from fastapi import APIRouter, Depends, Query

from ..db import get_db
from ..errors import AppError
from ..security import require_owner
from ..services.audit import AUDIT_ACTIONS
from ..services.timezones import business_tz, local_midnight_utc

router = APIRouter(tags=["audit"])


@router.get("/audit-log")
async def audit_log(
    date_from: Optional[dt.date] = None,
    date_to: Optional[dt.date] = None,
    user_id: Optional[str] = None,
    action: Optional[str] = None,
    product_id: Optional[str] = None,
    sale_id: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    owner: dict = Depends(require_owner),
    db=Depends(get_db),
):
    business_id = owner["business_id"]
    flt: dict = {"business_id": business_id}
    if action:
        if action not in AUDIT_ACTIONS:
            raise AppError(400, f"Action inconnue : {action}.")
        flt["action"] = action
    if user_id:
        flt["user_id"] = user_id
    if product_id:
        flt["product_ids"] = product_id
    if sale_id:
        # création et annulation d'une vente donnée
        flt["target_type"] = "sale"
        flt["target_id"] = sale_id
    tz = await business_tz(db, business_id)
    rng = {}
    if date_from:
        rng["$gte"] = local_midnight_utc(date_from, tz)
    if date_to:
        rng["$lt"] = local_midnight_utc(date_to + dt.timedelta(days=1), tz)
    if rng:
        flt["created_at"] = rng

    total = await db.audit_log.count_documents(flt)
    cursor = (
        db.audit_log.find(flt, {"_id": 0, "business_id": 0})
        .sort("created_at", -1).skip((page - 1) * page_size).limit(page_size)
    )
    items = [e async for e in cursor]
    return {"items": items, "total": total, "page": page, "page_size": page_size}
