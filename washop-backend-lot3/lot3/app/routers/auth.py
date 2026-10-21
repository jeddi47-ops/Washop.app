"""Routes d'authentification : inscription, connexion par appareil, sessions, mot de passe oublié."""
import datetime as dt
import hashlib
import logging
import secrets
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from ..config import settings
from ..db import get_db, run_transaction
from ..errors import AppError
from ..schemas import (
    ForgotPasswordIn, LoginIn, RegisterIn, ResetPasswordIn, SwitchModeIn, public_business, public_user,
)
from ..security import DEFAULT_SETTINGS, create_access_token, get_current_user, hash_password, verify_password
from ..services.audit import audit_entry, write_audit
from ..services.email import send_password_reset_email
from ..services.rate_limit import clear_hits, enforce_limit, is_limited, record_hits
from ..services.realtime import hub
from ..services.sessions import (
    ENDED_MESSAGES, REPLACED_MESSAGES, connection_status, end_sessions, open_session, session_out,
)
from ..services.stock import utcnow

router = APIRouter(tags=["auth"])
logger = logging.getLogger("washop.auth")

LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_PAIR_LIMIT = 5      # échecs max pour un couple (identifiant + IP)
LOGIN_IP_LIMIT = 20       # échecs max pour une IP, tous comptes confondus
REGISTER_IP_LIMIT = 10    # inscriptions max par IP
HOUR_SECONDS = 60 * 60
FORGOT_EMAIL_LIMIT = 3
FORGOT_IP_LIMIT = 10
RESET_TOKEN_TTL = dt.timedelta(minutes=30)
TOO_MANY = "Trop de tentatives. Réessayez dans quelques minutes."
GENERIC_FORGOT = "Si un compte existe pour cet email, un lien de réinitialisation a été envoyé."
BUSY = "Connexion en cours sur un autre appareil. Réessayez."


def _client_ip(request: Request) -> str:
    """
    Derrière un reverse proxy, l'IP réelle est dans X-Forwarded-For. On ne lit jamais la première entrée
    (falsifiable) : on prend l'entrée située TRUSTED_PROXY_COUNT positions avant la fin de la liste.
    """
    count = settings.TRUSTED_PROXY_COUNT
    if count > 0:
        forwarded = request.headers.get("x-forwarded-for", "")
        entries = [e.strip() for e in forwarded.split(",") if e.strip()]
        if len(entries) >= count:
            return entries[-count]
    return request.client.host if request.client else "unknown"


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _send_reset_safely(to: str, link: str) -> None:
    """Tâche de fond (threadpool) : l'envoi SMTP ne bloque pas la boucle d'événements."""
    try:
        send_password_reset_email(to, link)
    except Exception:
        logger.exception("Échec de l'envoi de l'email de réinitialisation")


def _replaced_entries(user: dict, replaced: list[dict], new_session: dict) -> list[dict]:
    return [
        audit_entry(
            user, "session_replaced", "session", r["session_id"],
            old_value={"device_type": r["device_type"]},
            new_value={"replaced_by": new_session["session_id"]},
            session_id=r["session_id"], device_type=r["device_type"],
        )
        for r in replaced
    ]


async def _notify_replaced(replaced: list[dict]) -> None:
    """Pousse « session_replaced » sur la socket de chaque session remplacée, puis la ferme."""
    for r in replaced:
        await hub.end_session(r["session_id"], {
            "type": "session_replaced",
            "code": "SESSION_REPLACED",
            "message": REPLACED_MESSAGES[r["device_type"]],
        })


async def end_sessions_live(sessions: list[dict], reason: str) -> None:
    for s in sessions:
        await hub.end_session(s["session_id"], {
            "type": "session_ended",
            "reason": reason,
            "message": ENDED_MESSAGES.get(reason, "Session terminée."),
        })


def _auth_response(user: dict, business: dict, sess: dict) -> dict:
    return {
        "access_token": create_access_token(user, sess["session_id"], sess["device_type"]),
        "token_type": "bearer",
        "user": public_user(user),
        "business": public_business(business),
        "session": session_out(sess),
    }


@router.post("/auth/register", status_code=201)
async def register(body: RegisterIn, request: Request, db=Depends(get_db)):
    ip_key = f"register:{_client_ip(request)}"
    await enforce_limit(db, "rate_limits", ip_key, REGISTER_IP_LIMIT, HOUR_SECONDS, TOO_MANY)
    await record_hits(db, "rate_limits", [ip_key])

    email = body.email.lower().strip()
    if await db.users.find_one({"email": email}, {"_id": 1}):
        raise HTTPException(409, "Cet email est déjà utilisé.")

    now = utcnow()
    business = {
        "id": str(uuid.uuid4()),
        "name": body.business_name.strip(),
        "type": body.business_type,
        "currency": body.currency.upper(),
        "address": body.address,
        "phone": body.phone,
        "timezone": body.timezone,
        "invoice_footer": None,
        "invoice_counter": 0,
        "settings": dict(DEFAULT_SETTINGS),
        "created_at": now,
    }
    user = {
        "id": str(uuid.uuid4()),
        "business_id": business["id"],
        "name": body.name.strip(),
        "email": email,
        "password_hash": hash_password(body.password),
        "role": "owner",
        "is_active": True,
        "token_version": 0,
        "created_at": now,
        "created_by": None,
    }

    async def _txn(s):
        await db.businesses.insert_one(dict(business), session=s)
        await db.users.insert_one(dict(user), session=s)
        sess, _ = await open_session(db, user, body.device_type, s)
        await write_audit(db, audit_entry(user, "login", "session", sess["session_id"],
                                          new_value={"device_type": sess["device_type"]},
                                          session_id=sess["session_id"], device_type=sess["device_type"]), session=s)
        return sess

    try:
        sess = await run_transaction(db, _txn)
    except DuplicateKeyError:
        raise HTTPException(409, "Cet email est déjà utilisé.")
    return _auth_response(user, business, sess)


@router.post("/auth/login")
async def login(body: LoginIn, request: Request, db=Depends(get_db)):
    """
    Connexion par appareil (device_type caisse ou scanner, caisse par défaut).
    Caissier : la session active du même appareil est remplacée et reçoit « session_replaced ».
    """
    login_value = (body.username or body.email or "").lower().strip()
    ip = _client_ip(request)
    pair_key, ip_key = f"pair:{login_value}|{ip}", f"ip:{ip}"
    await enforce_limit(db, "login_attempts", pair_key, LOGIN_PAIR_LIMIT, LOGIN_WINDOW_SECONDS, TOO_MANY)
    await enforce_limit(db, "login_attempts", ip_key, LOGIN_IP_LIMIT, LOGIN_WINDOW_SECONDS, TOO_MANY)

    user = await db.users.find_one({"$or": [{"email": login_value}, {"username": login_value}]}, {"_id": 0})
    if user is None or not user["is_active"] or not verify_password(body.password, user["password_hash"]):
        await record_hits(db, "login_attempts", [pair_key, ip_key])
        raise HTTPException(401, "Identifiant ou mot de passe incorrect.")
    await clear_hits(db, "login_attempts", pair_key)

    async def _txn(s):
        sess, replaced = await open_session(db, user, body.device_type, s)
        entries = [audit_entry(user, "login", "session", sess["session_id"],
                               new_value={"device_type": sess["device_type"]},
                               session_id=sess["session_id"], device_type=sess["device_type"])]
        entries += _replaced_entries(user, replaced, sess)
        await write_audit(db, entries, session=s)
        return sess, replaced

    try:
        sess, replaced = await run_transaction(db, _txn)
    except DuplicateKeyError:
        raise AppError(409, BUSY, code="LOGIN_CONFLICT")
    await _notify_replaced(replaced)
    business = await db.businesses.find_one({"id": user["business_id"]}, {"_id": 0})
    return _auth_response(user, business, sess)


@router.post("/auth/switch-mode")
async def switch_mode(body: SwitchModeIn, user: dict = Depends(get_current_user), db=Depends(get_db)):
    """Change le mode de l'appareil (caisse <-> scanner) sans ressaisir le mot de passe."""
    business = await db.businesses.find_one({"id": user["business_id"]}, {"_id": 0})
    if body.device_type == user["device_type"]:
        current = await db.sessions.find_one({"session_id": user["session_id"]}, {"_id": 0})
        return _auth_response(user, business, current)

    old_session_id = user["session_id"]

    async def _txn(s):
        await end_sessions(db, {"session_id": old_session_id}, "switch_mode", session=s)
        sess, replaced = await open_session(db, user, body.device_type, s)
        await write_audit(db, _replaced_entries(user, replaced, sess), session=s)
        return sess, replaced

    try:
        sess, replaced = await run_transaction(db, _txn)
    except DuplicateKeyError:
        raise AppError(409, BUSY, code="LOGIN_CONFLICT")
    await end_sessions_live([{"session_id": old_session_id}], "switch_mode")
    await _notify_replaced(replaced)
    return _auth_response(user, business, sess)


@router.post("/auth/logout")
async def logout(user: dict = Depends(get_current_user), db=Depends(get_db)):
    async def _txn(s):
        await end_sessions(db, {"session_id": user["session_id"]}, "logout", session=s)
        await write_audit(db, audit_entry(user, "logout", "session", user["session_id"]), session=s)

    await run_transaction(db, _txn)
    await end_sessions_live([{"session_id": user["session_id"]}], "logout")
    return {"detail": "Déconnecté."}


@router.post("/auth/refresh")
async def refresh(user: dict = Depends(get_current_user)):
    """Nouveau jeton pour la MÊME session (même session_id, même appareil, même version)."""
    return {"access_token": create_access_token(user), "token_type": "bearer"}


@router.get("/auth/me")
async def me(user: dict = Depends(get_current_user), db=Depends(get_db)):
    """Rôle, appareil, session valide et état caisse/scanner du même compte."""
    business = await db.businesses.find_one({"id": user["business_id"]})
    return {
        "user": public_user(user),
        "business": public_business(business),
        "session": {"session_id": user["session_id"], "device_type": user["device_type"], "active": True},
        "connections": await connection_status(db, user["id"]),
    }


@router.post("/auth/forgot-password")
async def forgot_password(
    body: ForgotPasswordIn, request: Request, background_tasks: BackgroundTasks, db=Depends(get_db)
):
    """Réponse toujours identique (compte existant ou non, limite dépassée ou non)."""
    email = body.email.lower().strip()
    email_key, ip_key = f"forgot-email:{email}", f"forgot-ip:{_client_ip(request)}"
    limited = (
        await is_limited(db, "rate_limits", email_key, FORGOT_EMAIL_LIMIT, HOUR_SECONDS)
        or await is_limited(db, "rate_limits", ip_key, FORGOT_IP_LIMIT, HOUR_SECONDS)
    )
    await record_hits(db, "rate_limits", [email_key, ip_key])
    if limited:
        return {"detail": GENERIC_FORGOT}

    user = await db.users.find_one({"email": email, "is_active": True})
    if user is not None:
        raw_token = secrets.token_urlsafe(32)
        now = utcnow()
        await db.password_reset_tokens.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "token_hash": _sha256(raw_token),
            "created_at": now,
            "expires_at": now + RESET_TOKEN_TTL,
            "used_at": None,
        })
        link = f"{settings.FRONTEND_URL.rstrip('/')}/reset-password?token={raw_token}"
        background_tasks.add_task(_send_reset_safely, user["email"], link)
    return {"detail": GENERIC_FORGOT}


@router.post("/auth/reset-password")
async def reset_password(body: ResetPasswordIn, db=Depends(get_db)):
    now = utcnow()
    record = await db.password_reset_tokens.find_one_and_update(
        {"token_hash": _sha256(body.token), "used_at": None, "expires_at": {"$gt": now}},
        {"$set": {"used_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if record is None:
        raise HTTPException(400, "Lien invalide ou expiré.")
    # Nouveau mot de passe + token_version incrémenté + sessions terminées : les anciens jetons sont refusés.
    await db.users.update_one(
        {"id": record["user_id"]},
        {"$set": {"password_hash": hash_password(body.new_password)}, "$inc": {"token_version": 1}},
    )
    await db.password_reset_tokens.update_many({"user_id": record["user_id"], "used_at": None}, {"$set": {"used_at": now}})
    ended = await end_sessions(db, {"user_id": record["user_id"]}, "password_reset")
    await end_sessions_live(ended, "password_reset")
    return {"detail": "Mot de passe modifié. Vous pouvez vous reconnecter."}
