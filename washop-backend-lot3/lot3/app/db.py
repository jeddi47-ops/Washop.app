"""Connexion MongoDB (Motor), contrôle replica set, helper de transaction et index."""
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from pymongo.errors import OperationFailure

from .config import settings

_client: AsyncIOMotorClient | None = None
_db: AsyncIOMotorDatabase | None = None


async def connect_db() -> AsyncIOMotorDatabase:
    global _client, _db
    _client = AsyncIOMotorClient(settings.MONGO_URL, tz_aware=True)
    _db = _client[settings.DB_NAME]
    return _db


def get_db() -> AsyncIOMotorDatabase:
    if _db is None:
        raise RuntimeError("Base de données non initialisée.")
    return _db


def close_db() -> None:
    if _client is not None:
        _client.close()


async def ensure_replica_set(db: AsyncIOMotorDatabase) -> None:
    """Les transactions MongoDB exigent un replica set : on échoue au démarrage avec un message clair."""
    info = await db.client.admin.command("hello")
    if not info.get("setName"):
        raise RuntimeError(
            "MongoDB doit tourner en replica set (requis pour les transactions). "
            "Lancez « docker compose up -d » (voir README) et utilisez "
            "MONGO_URL=mongodb://localhost:27017/?replicaSet=rs0"
        )


async def run_transaction(db: AsyncIOMotorDatabase, callback):
    """
    Exécute callback(session) dans UNE transaction MongoDB : tout réussit ou tout est annulé.
    Rejoue automatiquement la transaction en cas de conflit transitoire (écritures concurrentes).
    """
    async with await db.client.start_session() as session:
        return await session.with_transaction(callback)


def _index_name(keys: list[tuple[str, int]]) -> str:
    return "_".join(f"{field}_{direction}" for field, direction in keys)


async def _ensure_index(collection, keys, **options) -> None:
    """Crée l'index. S'il existe déjà avec d'autres options (ancienne version), il est recréé."""
    if isinstance(keys, str):
        keys = [(keys, 1)]
    name = options.pop("name", None) or _index_name(keys)
    try:
        await collection.create_index(keys, name=name, **options)
    except OperationFailure as exc:
        if exc.code not in (85, 86):  # IndexOptionsConflict, IndexKeySpecsConflict
            raise
        await collection.drop_index(name)
        await collection.create_index(keys, name=name, **options)


async def create_indexes(db: AsyncIOMotorDatabase) -> None:
    await _ensure_index(db.businesses, "id", unique=True)
    # Email unique seulement s'il est renseigné (un caissier peut ne pas en avoir)
    await _ensure_index(db.users, "email", unique=True, partialFilterExpression={"email": {"$type": "string"}})
    await _ensure_index(db.users, "username", unique=True, partialFilterExpression={"username": {"$type": "string"}})
    await _ensure_index(db.users, "id", unique=True)
    await _ensure_index(db.users, [("business_id", 1), ("created_at", 1)])
    await _ensure_index(db.products, "id", unique=True)
    # Un code par produit, unique dans le commerce parmi les produits NON archivés
    await _ensure_index(db.products, [("business_id", 1), ("code", 1)], unique=True,
                        partialFilterExpression={"is_archived": False, "code": {"$type": "string"}})
    await _ensure_index(db.products, [("business_id", 1), ("qr_code", 1)], unique=True,
                        partialFilterExpression={"is_archived": False, "qr_code": {"$type": "string"}})
    await _ensure_index(db.products, [("business_id", 1), ("name", 1)])
    await _ensure_index(db.sales, "id", unique=True)
    await _ensure_index(db.sales, [("business_id", 1), ("created_at", 1)])
    await _ensure_index(db.sales, [("business_id", 1), ("number", 1)], unique=True)
    # Identifiant unique de paiement (client_sale_id) : une seule vente par boutique et par identifiant
    await _ensure_index(db.sales, [("business_id", 1), ("client_sale_id", 1)], unique=True,
                        partialFilterExpression={"client_sale_id": {"$type": "string"}})
    await _ensure_index(db.sales, [("business_id", 1), ("created_by", 1), ("created_at", -1)])
    await _ensure_index(db.stock_movements, [("business_id", 1), ("product_id", 1), ("created_at", 1)])
    await _ensure_index(db.stock_movements, [("business_id", 1), ("type", 1), ("created_at", 1)])
    # Fonds de réappro : départs et ajustements
    await _ensure_index(db.fund_entries, "id", unique=True)
    await _ensure_index(db.fund_entries, [("business_id", 1), ("type", 1), ("created_at", -1)])
    # Crédits clients : un crédit par vente ; recherche par statut puis par nom
    await _ensure_index(db.credits, "id", unique=True)
    await _ensure_index(db.credits, [("business_id", 1), ("sale_id", 1)], unique=True)
    await _ensure_index(db.credits, [("business_id", 1), ("status", 1), ("created_at", 1)])
    await _ensure_index(db.credits, [("business_id", 1), ("customer_name", 1)])
    await _ensure_index(db.credits, [("business_id", 1), ("customer_id_key", 1), ("status", 1)])
    # Sessions : une seule session active par (caissier, type d'appareil). Le patron n'est pas concerné.
    await _ensure_index(db.sessions, "session_id", unique=True)
    await _ensure_index(db.sessions, [("user_id", 1), ("device_type", 1)], unique=True,
                        name="one_active_session_per_device",
                        partialFilterExpression={"active": True, "exclusive": True})
    await _ensure_index(db.sessions, [("user_id", 1), ("active", 1)])
    # Journal d'audit
    await _ensure_index(db.audit_log, [("business_id", 1), ("created_at", -1)])
    await _ensure_index(db.audit_log, [("business_id", 1), ("user_id", 1), ("created_at", -1)])
    await _ensure_index(db.audit_log, [("business_id", 1), ("action", 1), ("created_at", -1)])
    await _ensure_index(db.audit_log, [("business_id", 1), ("product_ids", 1), ("created_at", -1)])
    # Tentatives de connexion : expirent automatiquement après 15 minutes
    await _ensure_index(db.login_attempts, "created_at", expireAfterSeconds=15 * 60)
    await _ensure_index(db.login_attempts, "key")
    # Limites par heure (inscription, mot de passe oublié)
    await _ensure_index(db.rate_limits, "created_at", expireAfterSeconds=60 * 60)
    await _ensure_index(db.rate_limits, "key")
    # Mot de passe oublié : token haché, expire à expires_at
    await _ensure_index(db.password_reset_tokens, "token_hash", unique=True)
    await _ensure_index(db.password_reset_tokens, "expires_at", expireAfterSeconds=0)
