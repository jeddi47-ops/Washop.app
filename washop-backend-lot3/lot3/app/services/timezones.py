"""Fuseau horaire par commerce (IANA). Les dates restent stockées en UTC."""
import datetime as dt
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def validate_timezone(name: str) -> str:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("fuseau horaire inconnu (nom IANA attendu, ex. Africa/Abidjan)")
    return name


def tz_of(business: dict) -> ZoneInfo:
    return ZoneInfo((business or {}).get("timezone") or "UTC")


async def business_tz(db, business_id: str) -> ZoneInfo:
    business = await db.businesses.find_one({"id": business_id}, {"_id": 0, "timezone": 1})
    return tz_of(business or {})


def local_today(tz: ZoneInfo) -> dt.date:
    return dt.datetime.now(tz).date()


def local_midnight_utc(day: dt.date, tz: ZoneInfo) -> dt.datetime:
    """Minuit du jour donné dans le fuseau du commerce, renvoyé en UTC."""
    return dt.datetime.combine(day, dt.time(), tzinfo=tz).astimezone(dt.timezone.utc)
