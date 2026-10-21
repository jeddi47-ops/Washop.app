"""
Sessions d'appareil (caisse ou scanner).
Règle : un caissier a au plus UNE session active par type d'appareil. Le patron n'a pas de limite.
"""
import datetime as dt
import uuid

from .stock import utcnow

DEVICE_TYPES = ("caisse", "scanner")
REPLACED_MESSAGES = {
    "caisse": "Tu as été déconnecté : ta caisse a été ouverte sur un autre appareil.",
    "scanner": "Tu as été déconnecté : ton scanner a été ouvert sur un autre appareil.",
}
ENDED_MESSAGES = {
    "logout": "Session terminée.",
    "switch_mode": "Cet appareil a changé de mode.",
    "account_disabled": "Ton compte a été désactivé par le patron.",
    "password_reset": "Ton mot de passe a été changé. Reconnecte-toi.",
}
CONNECTED_WINDOW = dt.timedelta(minutes=2)  # sans signe de vie depuis 2 min : affiché « déconnecté »
TOUCH_EVERY = dt.timedelta(seconds=20)


def session_out(sess: dict) -> dict:
    return {
        "session_id": sess["session_id"],
        "device_type": sess["device_type"],
        "active": sess["active"],
        "created_at": sess["created_at"],
        "last_seen": sess.get("last_seen"),
    }


async def open_session(db, user: dict, device_type: str, session=None) -> tuple[dict, list[dict]]:
    """Crée une session. Pour un caissier, la session active du même (user_id, device_type) est remplacée."""
    now = utcnow()
    exclusive = user["role"] != "owner"
    replaced: list[dict] = []
    if exclusive:
        replaced = await db.sessions.find(
            {"user_id": user["id"], "device_type": device_type, "active": True}, {"_id": 0}, session=session
        ).to_list(None)
        if replaced:
            await db.sessions.update_many(
                {"session_id": {"$in": [s["session_id"] for s in replaced]}},
                {"$set": {"active": False, "replaced_at": now, "ended_at": now, "ended_reason": "replaced"}},
                session=session,
            )
    doc = {
        "session_id": str(uuid.uuid4()),
        "user_id": user["id"],
        "business_id": user["business_id"],
        "device_type": device_type,
        "exclusive": exclusive,  # index unique partiel : une seule session active par appareil pour un caissier
        "active": True,
        "created_at": now,
        "last_seen": now,
        "replaced_at": None,
        "ended_at": None,
        "ended_reason": None,
    }
    await db.sessions.insert_one(dict(doc), session=session)
    return doc, replaced


async def end_sessions(db, flt: dict, reason: str, session=None) -> list[dict]:
    """Termine les sessions actives correspondant au filtre. Renvoie les sessions terminées."""
    now = utcnow()
    ended = await db.sessions.find({**flt, "active": True}, {"_id": 0}, session=session).to_list(None)
    if ended:
        await db.sessions.update_many(
            {"session_id": {"$in": [s["session_id"] for s in ended]}},
            {"$set": {"active": False, "ended_at": now, "ended_reason": reason}},
            session=session,
        )
    return ended


async def touch_session(db, sess: dict) -> None:
    """Met à jour last_seen, au plus toutes les 20 secondes (évite une écriture par requête)."""
    last = sess.get("last_seen")
    if last is None or utcnow() - last > TOUCH_EVERY:
        await db.sessions.update_one({"session_id": sess["session_id"], "active": True}, {"$set": {"last_seen": utcnow()}})


async def touch_by_id(db, session_id: str) -> None:
    await db.sessions.update_one({"session_id": session_id, "active": True}, {"$set": {"last_seen": utcnow()}})


async def connection_status(db, user_id: str) -> dict:
    """caisse_connected / scanner_connected : session active vue il y a moins de 2 minutes."""
    since = utcnow() - CONNECTED_WINDOW
    out = {}
    for device in DEVICE_TYPES:
        found = await db.sessions.find_one(
            {"user_id": user_id, "device_type": device, "active": True, "last_seen": {"$gte": since}}, {"_id": 1}
        )
        out[f"{device}_connected"] = found is not None
    return out
