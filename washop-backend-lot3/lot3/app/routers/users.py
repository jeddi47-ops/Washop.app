"""Comptes employés (caissiers), gérés par le patron."""
import uuid

from fastapi import APIRouter, Depends
from pymongo.errors import DuplicateKeyError

from ..db import get_db, run_transaction
from ..errors import AppError
from ..schemas import SellerCreate, UserPatch, public_user
from ..security import hash_password, require_owner
from ..services.audit import audit_entry, write_audit
from ..services.sessions import CONNECTED_WINDOW, end_sessions
from ..services.stock import utcnow
from .auth import end_sessions_live

router = APIRouter(tags=["users"])


async def _sessions_summary(db, user_id: str) -> list[dict]:
    since = utcnow() - CONNECTED_WINDOW
    out = []
    async for s in db.sessions.find({"user_id": user_id, "active": True}, {"_id": 0}).sort("created_at", -1):
        out.append({
            "session_id": s["session_id"],
            "device_type": s["device_type"],
            "last_seen": s.get("last_seen"),
            "connected": bool(s.get("last_seen") and s["last_seen"] >= since),
        })
    return out


@router.post("/users", status_code=201)
async def create_seller(body: SellerCreate, owner: dict = Depends(require_owner), db=Depends(get_db)):
    """Crée un caissier rattaché au commerce du patron (jamais un autre commerce)."""
    email = body.email.lower().strip() if body.email else None
    if await db.users.find_one({"username": body.username}, {"_id": 1}):
        raise AppError(409, "Cet identifiant est déjà utilisé.", code="USERNAME_TAKEN")
    if email and await db.users.find_one({"email": email}, {"_id": 1}):
        raise AppError(409, "Cet email est déjà utilisé.", code="EMAIL_TAKEN")

    user = {
        "id": str(uuid.uuid4()),
        "business_id": owner["business_id"],
        "name": body.name.strip(),
        "username": body.username,
        "password_hash": hash_password(body.password),
        "role": "seller",  # caissier
        "is_active": True,
        "token_version": 0,
        "created_at": utcnow(),
        "created_by": owner["id"],
    }
    if email:
        user["email"] = email

    async def _txn(s):
        await db.users.insert_one(dict(user), session=s)
        await write_audit(db, audit_entry(owner, "user_created", "user", user["id"],
                                          new_value={"name": user["name"], "username": user["username"], "role": "seller"}), session=s)

    try:
        await run_transaction(db, _txn)
    except DuplicateKeyError:
        raise AppError(409, "Cet identifiant ou cet email est déjà utilisé.", code="USERNAME_TAKEN")
    return public_user(user)


@router.get("/users")
async def list_users(owner: dict = Depends(require_owner), db=Depends(get_db)):
    items = []
    async for u in db.users.find({"business_id": owner["business_id"]}, {"_id": 0}).sort("created_at", 1):
        items.append({**public_user(u), "sessions": await _sessions_summary(db, u["id"])})
    return {"items": items, "total": len(items)}


@router.patch("/users/{user_id}")
async def update_seller(user_id: str, body: UserPatch, owner: dict = Depends(require_owner), db=Depends(get_db)):
    """Activer, désactiver, renommer, réinitialiser le mot de passe d'un caissier. Désactivation : sessions coupées tout de suite."""
    business_id = owner["business_id"]
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if not changes:
        raise AppError(400, "Aucune modification demandée.")

    async def _txn(s):
        target = await db.users.find_one({"id": user_id, "business_id": business_id}, {"_id": 0}, session=s)
        if target is None:
            raise AppError(404, "Compte introuvable.")
        if target["role"] == "owner":
            raise AppError(400, "Le compte du patron ne se modifie pas ici.")

        update: dict = {"$set": {}}
        entries, ended, reasons = [], [], []
        if "name" in changes:
            update["$set"]["name"] = changes["name"].strip()
        if "is_active" in changes:
            update["$set"]["is_active"] = changes["is_active"]
            if target["is_active"] and not changes["is_active"]:
                entries.append(audit_entry(owner, "user_disabled", "user", user_id,
                                           old_value={"is_active": True}, new_value={"is_active": False}))
                reasons.append("account_disabled")
        if "password" in changes:
            update["$set"]["password_hash"] = hash_password(changes["password"])
            update["$inc"] = {"token_version": 1}  # anciens jetons refusés
            entries.append(audit_entry(owner, "user_password_reset", "user", user_id))
            reasons.append("password_reset")

        await db.users.update_one({"id": user_id, "business_id": business_id}, update, session=s)
        if reasons:
            ended = await end_sessions(db, {"user_id": user_id}, reasons[0], session=s)
        await write_audit(db, entries, session=s)
        updated = await db.users.find_one({"id": user_id}, {"_id": 0}, session=s)
        return updated, ended, (reasons[0] if reasons else None)

    updated, ended, reason = await run_transaction(db, _txn)
    if ended:
        await end_sessions_live(ended, reason)  # coupe aussi les WebSockets de la caisse et du scanner
    return {**public_user(updated), "sessions": await _sessions_summary(db, user_id)}
