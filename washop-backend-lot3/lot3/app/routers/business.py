"""Routes du commerce."""
from fastapi import APIRouter, Depends

from ..db import get_db
from ..schemas import BusinessUpdate, public_business
from ..security import get_current_user, require_owner

router = APIRouter(tags=["business"])
CLEARABLE_FIELDS = ("address", "phone", "invoice_footer")


@router.get("/business")
async def get_business(user: dict = Depends(get_current_user), db=Depends(get_db)):
    return public_business(await db.businesses.find_one({"id": user["business_id"]}))


@router.put("/business")
async def update_business(body: BusinessUpdate, user: dict = Depends(require_owner), db=Depends(get_db)):
    business_id = user["business_id"]
    sent = body.model_dump(exclude_unset=True)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    # Coordonnées : une valeur vide ou null efface le champ (adresse, téléphone, pied de facture)
    for key in CLEARABLE_FIELDS:
        if key in sent and (sent[key] is None or (isinstance(sent[key], str) and not sent[key].strip())):
            changes[key] = None
    settings_changes = changes.pop("settings", None) or {}
    update = {f"settings.{key}": value for key, value in settings_changes.items()}
    if "currency" in changes:
        changes["currency"] = changes["currency"].upper()
    update.update(changes)
    if update:
        await db.businesses.update_one({"id": business_id}, {"$set": update})
    return public_business(await db.businesses.find_one({"id": business_id}))
