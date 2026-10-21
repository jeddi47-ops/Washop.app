"""Hash des mots de passe, JWT avec session, dépendances get_current_user et require_owner."""
import datetime as dt

import bcrypt
import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings
from .db import get_db
from .errors import AppError
from .services.sessions import ENDED_MESSAGES, REPLACED_MESSAGES, touch_session

ALGORITHM = "HS256"
ACCOUNT_DISABLED_MESSAGE = "Ton compte a été désactivé. Contacte le propriétaire."
DEFAULT_SETTINGS = {"low_stock_default_threshold": 5, "expiry_alert_days": 30, "forecast_alert_days": 7}
_bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(user: dict, session_id: str | None = None, device_type: str | None = None) -> str:
    """Le jeton porte user_id, role, shop_id (= business_id), session_id et device_type."""
    now = dt.datetime.now(dt.timezone.utc)
    payload = {
        "sub": user["id"],
        "user_id": user["id"],
        "business_id": user["business_id"],
        "shop_id": user["business_id"],
        "role": user["role"],
        "tv": int(user.get("token_version", 0)),  # révoqué si la version change (reset mot de passe)
        "session_id": session_id or user.get("session_id"),
        "device_type": device_type or user.get("device_type"),
        "iat": now,
        "exp": now + dt.timedelta(minutes=settings.JWT_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=ALGORITHM)


def _unauthorized(message: str = "Session invalide ou expirée. Reconnectez-vous.", code: str = "INVALID_TOKEN") -> AppError:
    return AppError(401, message, code=code, headers={"WWW-Authenticate": "Bearer"})


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        raise _unauthorized()


async def authenticate_token(db, token: str) -> tuple[dict, dict]:
    """
    Vérifie jeton, compte, version de jeton ET session active. Utilisé par HTTP et WebSocket.
    Règle 5.2 : le business_id vient du jeton et de la base, jamais du client.
    """
    payload = decode_access_token(token)
    user = await db.users.find_one({"id": payload.get("user_id") or payload.get("sub")}, {"_id": 0})
    if user is None or user["business_id"] != payload.get("business_id"):
        raise _unauthorized()
    if not user.get("is_active", False):
        raise AppError(401, ACCOUNT_DISABLED_MESSAGE, code="ACCOUNT_DISABLED", headers={"WWW-Authenticate": "Bearer"})
    if int(user.get("token_version", 0)) != payload.get("tv", -1):
        raise _unauthorized()
    session_id = payload.get("session_id")
    if not session_id:
        raise _unauthorized()  # jeton d'avant les sessions : reconnexion obligatoire
    sess = await db.sessions.find_one({"session_id": session_id, "user_id": user["id"]}, {"_id": 0})
    if sess is None:
        raise _unauthorized()
    if not sess["active"]:
        if sess.get("replaced_at"):
            raise _unauthorized(REPLACED_MESSAGES[sess["device_type"]], code="SESSION_REPLACED")
        raise _unauthorized(ENDED_MESSAGES.get(sess.get("ended_reason"), "Session terminée. Reconnectez-vous."), code="SESSION_ENDED")
    return {**user, "session_id": session_id, "device_type": sess["device_type"]}, sess


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db=Depends(get_db),
) -> dict:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized()
    user, sess = await authenticate_token(db, credentials.credentials)
    await touch_session(db, sess)
    return user


async def require_owner(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "owner":
        raise AppError(403, "Action réservée au patron du commerce.")
    return user
