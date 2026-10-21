"""Limitation de débit stockée dans MongoDB : survit aux redémarrages, marche avec plusieurs processus."""
import datetime as dt

from fastapi import HTTPException

from .stock import utcnow


async def is_limited(db, collection: str, key: str, limit: int, window_seconds: int) -> bool:
    since = utcnow() - dt.timedelta(seconds=window_seconds)
    count = await db[collection].count_documents({"key": key, "created_at": {"$gte": since}})
    return count >= limit


async def enforce_limit(db, collection: str, key: str, limit: int, window_seconds: int, message: str) -> None:
    if await is_limited(db, collection, key, limit, window_seconds):
        raise HTTPException(429, message)


async def record_hits(db, collection: str, keys: list[str]) -> None:
    now = utcnow()
    await db[collection].insert_many([{"key": k, "created_at": now} for k in keys])


async def clear_hits(db, collection: str, key: str) -> None:
    await db[collection].delete_many({"key": key})
