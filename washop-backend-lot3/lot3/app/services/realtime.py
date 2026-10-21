"""
Canaux temps réel caisse <-> scanner.
Les sockets sont rangées par session_id, et le canal d'un utilisateur est déduit de son jeton, jamais du client.
Registre en mémoire : l'API doit tourner en UN seul processus (voir README).
"""
import logging

from fastapi.encoders import jsonable_encoder

logger = logging.getLogger("washop.realtime")


class Hub:
    def __init__(self) -> None:
        self._by_session: dict[str, dict] = {}

    def register(self, session_id: str, user_id: str, device_type: str, ws):
        """Enregistre la socket. Renvoie l'ancienne socket de la même session (reconnexion) s'il y en a une."""
        old = self._by_session.get(session_id)
        self._by_session[session_id] = {"ws": ws, "user_id": user_id, "device_type": device_type}
        return old["ws"] if old else None

    def unregister(self, session_id: str, ws) -> None:
        entry = self._by_session.get(session_id)
        if entry and entry["ws"] is ws:
            del self._by_session[session_id]

    def sockets(self, user_id: str, device_type: str) -> list:
        return [e["ws"] for e in self._by_session.values() if e["user_id"] == user_id and e["device_type"] == device_type]

    def has(self, user_id: str, device_type: str) -> bool:
        return bool(self.sockets(user_id, device_type))

    @staticmethod
    async def send(ws, message: dict) -> bool:
        try:
            await ws.send_json(jsonable_encoder(message))
            return True
        except Exception:
            return False

    async def send_to_user(self, user_id: str, device_type: str, message: dict) -> int:
        sent = 0
        for ws in self.sockets(user_id, device_type):
            if await self.send(ws, message):
                sent += 1
        return sent

    async def end_session(self, session_id: str, message: dict, code: int = 4401) -> None:
        """Pousse un message puis ferme la socket de la session (remplacée, terminée, compte désactivé)."""
        entry = self._by_session.pop(session_id, None)
        if not entry:
            return
        await self.send(entry["ws"], message)
        try:
            await entry["ws"].close(code=code)
        except Exception:
            pass


hub = Hub()
