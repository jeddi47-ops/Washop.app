"""
Journal d'audit, en ajout seulement (aucune route de modification ni de suppression).
Chaque écriture est faite dans la même transaction que le changement qu'elle trace.
"""
import uuid

from ..errors import AppError
from .stock import utcnow

MOTIF_CODES = ("erreur_de_saisie", "client_a_change_avis", "produit_abime", "autre")
MOTIF_NOTE_MIN = 10
AUDIT_ACTIONS = (
    "product_created", "product_updated", "product_price_changed", "product_stock_adjusted", "product_archived",
    "sale_created", "sale_cancelled", "user_created", "user_disabled", "user_password_reset",
    "login", "logout", "session_replaced",
)


def check_motif(user: dict, motif_code: str | None, motif_note: str | None) -> tuple[str | None, str | None]:
    """Caissier : motif obligatoire. « autre » : précision de 10 caractères minimum (pour tous)."""
    note = (motif_note or "").strip() or None
    if motif_code is None and user["role"] != "owner":
        raise AppError(400, "Motif obligatoire pour cette action.", code="MOTIF_REQUIRED")
    if motif_code == "autre" and (note is None or len(note) < MOTIF_NOTE_MIN):
        raise AppError(400, "Avec le motif « autre », précise la raison en 10 caractères minimum.", code="MOTIF_REQUIRED")
    return motif_code, note


def audit_entry(
    user: dict,
    action: str,
    target_type: str,
    target_id: str,
    *,
    old_value=None,
    new_value=None,
    motif_code: str | None = None,
    motif_note: str | None = None,
    product_ids: list[str] | None = None,
    session_id: str | None = None,
    device_type: str | None = None,
) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "business_id": user["business_id"],
        "user_id": user["id"],
        "user_name": user.get("name"),
        "role": user["role"],
        "action": action,
        "target_type": target_type,
        "target_id": target_id,
        "old_value": old_value,
        "new_value": new_value,
        "motif_code": motif_code,
        "motif_note": motif_note,
        "product_ids": product_ids or [],  # sert au filtre « par produit »
        "session_id": session_id or user.get("session_id"),
        "device_type": device_type or user.get("device_type"),
        "created_at": utcnow(),
    }


async def write_audit(db, entries, session=None) -> None:
    if isinstance(entries, dict):
        entries = [entries]
    if entries:
        await db.audit_log.insert_many([dict(e) for e in entries], session=session)
