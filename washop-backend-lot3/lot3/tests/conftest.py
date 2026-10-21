"""
Configuration des tests.
- Sans MONGO_URL_TEST : seuls les tests unitaires tournent, les tests d'intégration sont ignorés.
- Avec MONGO_URL_TEST (MongoDB en replica set, ex. docker compose up -d) : tests d'intégration complets.
"""
import os

import pytest

MONGO_TEST = os.getenv("MONGO_URL_TEST")
os.environ.setdefault("JWT_SECRET", "test-secret-washop-not-for-production-0123456789")
if MONGO_TEST:
    os.environ["MONGO_URL"] = MONGO_TEST
    os.environ["DB_NAME"] = "washop_test"  # jamais la base de développement


@pytest.fixture
async def env(monkeypatch):
    if not MONGO_TEST:
        pytest.skip("MONGO_URL_TEST non défini : test d'intégration ignoré")
    import httpx

    from app.config import settings
    from app.db import close_db, connect_db, create_indexes, ensure_replica_set
    from server import app as fastapi_app

    db = await connect_db()
    await db.client.drop_database(settings.DB_NAME)
    await ensure_replica_set(db)
    await create_indexes(db)
    # raise_app_exceptions=False : une erreur serveur devient un 500 que le test peut vérifier
    transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield {"client": client, "db": db, "mp": monkeypatch}
    await db.client.drop_database(settings.DB_NAME)
    close_db()
