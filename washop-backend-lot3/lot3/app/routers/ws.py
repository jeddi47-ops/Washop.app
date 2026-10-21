"""
Scan à distance : /api/ws/caisse (écran de caisse) et /api/ws/scanner (téléphone en mode scanner).

Protocole (JSON) :
- 1er message du client : {"type": "auth", "token": "<jeton>"}. Le jeton n'est jamais dans l'URL.
- Réponse : {"type": "auth_ok", ...} ou {"type": "auth_error", "code": ...} puis fermeture.
- Scanner -> serveur : {"type": "scan", "code": "...", "scan_id": "facultatif"}.
- Serveur -> scanner : {"type": "scan_ack", "status": "ok" | "not_found" | "no_caisse", ...}.
- Serveur -> caisse : {"type": "product_scanned", "product": {...}} ou {"type": "scan_error", "reason": "not_found"}.
- Caisse <- scanner_connected / scanner_disconnected. Scanner <- caisse_connected / caisse_disconnected.
- Ping : le client envoie {"type": "ping"} toutes les 25 s environ, le serveur répond {"type": "pong"}.
- Session remplacée : {"type": "session_replaced", "message": ...} puis fermeture (code 4401).
"""
import asyncio
import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..db import get_db
from ..errors import AppError
from ..schemas import product_out
from ..security import authenticate_token
from ..services.realtime import hub
from ..services.sessions import touch_by_id

router = APIRouter(tags=["realtime"])
logger = logging.getLogger("washop.ws")

AUTH_TIMEOUT = 10      # secondes pour envoyer le message auth
IDLE_PING = 25         # le serveur envoie un ping s'il n'a rien reçu depuis 25 s
MAX_SILENCE = 120      # au-delà de 2 minutes sans message, la connexion est fermée
CLOSE_AUTH = 4401
CLOSE_WRONG_DEVICE = 4403
CLOSE_IDLE = 4408


async def _close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:
        pass


def _warn_foreign_target(msg: dict, user: dict, session_id: str) -> None:
    """Le canal vient du jeton. Toute tentative de viser un autre canal est ignorée ET signalée dans les logs."""
    own = {
        "user_id": user["id"], "target_user_id": user["id"], "channel": user["id"],
        "session_id": session_id, "shop_id": user["business_id"], "business_id": user["business_id"],
    }
    for key, expected in own.items():
        if key in msg and msg[key] != expected:
            logger.warning(
                "ALERTE sécurité : utilisateur %s (commerce %s) a tenté de viser %s=%r par WebSocket. Ignoré.",
                user["id"], user["business_id"], key, msg[key],
            )


async def _authenticate(ws: WebSocket, db, expected_device: str):
    try:
        first = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=AUTH_TIMEOUT))
    except (asyncio.TimeoutError, ValueError, WebSocketDisconnect, RuntimeError):
        await _close(ws, CLOSE_AUTH)
        return None
    if not isinstance(first, dict) or first.get("type") != "auth" or not first.get("token"):
        await hub.send(ws, {"type": "auth_error", "code": "AUTH_REQUIRED", "message": "Premier message attendu : auth."})
        await _close(ws, CLOSE_AUTH)
        return None
    try:
        user, sess = await authenticate_token(db, str(first["token"]))
    except AppError as exc:
        await hub.send(ws, {"type": "auth_error", "code": exc.code or "INVALID_TOKEN", "message": exc.detail})
        await _close(ws, CLOSE_AUTH)
        return None
    if sess["device_type"] != expected_device:
        await hub.send(ws, {
            "type": "auth_error", "code": "WRONG_DEVICE_TYPE",
            "message": f"Cette session est en mode {sess['device_type']}, pas {expected_device}.",
        })
        await _close(ws, CLOSE_WRONG_DEVICE)
        return None
    return user, sess


async def _handle_scan(db, ws: WebSocket, user: dict, msg: dict) -> None:
    code = str(msg.get("code") or "").strip()[:128]
    ack = {"type": "scan_ack", "code": code}
    if msg.get("scan_id") is not None:
        ack["scan_id"] = msg["scan_id"]

    if not hub.has(user["id"], "caisse"):
        await hub.send(ws, {**ack, "status": "no_caisse", "message": "Aucune caisse ouverte."})
        return
    product = None
    if code:
        product = await db.products.find_one(
            {"business_id": user["business_id"], "is_archived": False, "$or": [{"code": code}, {"qr_code": code}]},
            {"_id": 0},
        )
    if product is None:  # inconnu ou archivé
        await hub.send_to_user(user["id"], "caisse", {"type": "scan_error", "reason": "not_found", "code": code})
        await hub.send(ws, {**ack, "status": "not_found"})
        return
    # Pas de dédoublonnage côté serveur : deux scans = deux articles, la caisse augmente la quantité.
    delivered = await hub.send_to_user(user["id"], "caisse", {
        "type": "product_scanned", "code": code, "product": product_out(product, user["role"]),
        **({"scan_id": msg["scan_id"]} if msg.get("scan_id") is not None else {}),
    })
    status = "ok" if delivered else "no_caisse"
    await hub.send(ws, {**ack, "status": status, "product_name": product["name"]})


async def _serve(ws: WebSocket, device_type: str) -> None:
    await ws.accept()
    db = get_db()
    auth = await _authenticate(ws, db, device_type)
    if auth is None:
        return
    user, sess = auth
    session_id, user_id = sess["session_id"], user["id"]
    other = "scanner" if device_type == "caisse" else "caisse"

    # Reconnexion avec la même session : l'ancienne socket est fermée, la nouvelle prend sa place.
    old = hub.register(session_id, user_id, device_type, ws)
    if old is not None and old is not ws:
        await _close(old, 4000)
    await touch_by_id(db, session_id)
    await hub.send(ws, {
        "type": "auth_ok", "session_id": session_id, "device_type": device_type,
        f"{other}_connected": hub.has(user_id, other),
    })
    await hub.send_to_user(user_id, other, {"type": f"{device_type}_connected"})

    last_message = time.monotonic()
    try:
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=IDLE_PING)
            except asyncio.TimeoutError:
                if time.monotonic() - last_message > MAX_SILENCE:
                    await _close(ws, CLOSE_IDLE)
                    break
                await hub.send(ws, {"type": "ping"})
                continue
            last_message = time.monotonic()
            try:
                msg = json.loads(raw)
            except ValueError:
                await hub.send(ws, {"type": "error", "reason": "invalid_json"})
                continue
            if not isinstance(msg, dict):
                await hub.send(ws, {"type": "error", "reason": "invalid_message"})
                continue
            _warn_foreign_target(msg, user, session_id)

            # À chaque message : la session doit être encore active.
            current = await db.sessions.find_one({"session_id": session_id}, {"_id": 0})
            if not current or not current.get("active"):
                replaced = bool(current and current.get("replaced_at"))
                await hub.send(ws, {
                    "type": "session_replaced" if replaced else "session_ended",
                    "code": "SESSION_REPLACED" if replaced else "SESSION_ENDED",
                })
                await _close(ws, CLOSE_AUTH)
                break
            await touch_by_id(db, session_id)

            kind = msg.get("type")
            if kind == "ping":
                await hub.send(ws, {"type": "pong"})
            elif kind == "pong":
                pass
            elif kind == "scan" and device_type == "scanner":
                await _handle_scan(db, ws, user, msg)
            else:
                await hub.send(ws, {"type": "error", "reason": "unsupported_message"})
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Erreur WebSocket (%s, session %s)", device_type, session_id)
    finally:
        hub.unregister(session_id, ws)
        if not hub.has(user_id, device_type):
            await hub.send_to_user(user_id, other, {"type": f"{device_type}_disconnected"})


@router.websocket("/ws/caisse")
async def ws_caisse(ws: WebSocket):
    await _serve(ws, "caisse")


@router.websocket("/ws/scanner")
async def ws_scanner(ws: WebSocket):
    await _serve(ws, "scanner")
