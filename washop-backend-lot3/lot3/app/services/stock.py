"""Mouvements de stock atomiques (règle 5.3) et utilitaires de date. Toutes les fonctions acceptent une session de transaction."""
import datetime as dt
import uuid

from pymongo import ReturnDocument


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def start_of_day(day: dt.date) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(), tzinfo=dt.timezone.utc)


async def apply_stock_delta(db, business_id: str, product_id: str, delta: float, session=None):
    """
    Modifie le stock en une seule opération atomique.
    - delta < 0 : appliqué seulement si quantity >= retrait (jamais de stock négatif). Renvoie None sinon.
    - delta > 0 : toujours appliqué (ré-entrée, annulation de vente).
    """
    flt = {"id": product_id, "business_id": business_id}
    if delta < 0:
        flt["is_archived"] = False
        flt["quantity"] = {"$gte": -delta}
    return await db.products.find_one_and_update(
        flt,
        [{"$set": {
            "quantity": {"$round": [{"$add": ["$quantity", delta]}, 3]},
            "updated_at": utcnow(),
        }}],
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0},
        session=session,
    )


def build_movement(*, business_id, product_id, movement_type, quantity_change, quantity_after,
                   created_by, reason=None, sale_id=None, unit_cost=None) -> dict:
    """Règle 4.5 : toute modification de quantité passe par un mouvement."""
    return {
        "id": str(uuid.uuid4()),
        "business_id": business_id,
        "product_id": product_id,
        "type": movement_type,
        "quantity_change": quantity_change,
        "quantity_after": quantity_after,
        "reason": reason,
        "sale_id": sale_id,
        "unit_cost": unit_cost,  # coût d'achat unitaire (réapprovisionnements) : sert au fonds de réappro
        "created_by": created_by,
        "created_at": utcnow(),
    }


async def record_movement(db, *, session=None, **fields) -> None:
    await db.stock_movements.insert_one(build_movement(**fields), session=session)
