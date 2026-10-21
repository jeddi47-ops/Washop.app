"""Lecture de la configuration depuis les variables d'environnement."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    MONGO_URL: str
    DB_NAME: str
    JWT_SECRET: str
    JWT_EXPIRE_MINUTES: int
    CORS_ORIGINS: list[str]
    FRONTEND_URL: str
    SMTP_HOST: str
    SMTP_PORT: int
    SMTP_USER: str
    SMTP_PASSWORD: str
    SMTP_FROM: str
    SMTP_STARTTLS: bool
    TRUSTED_PROXY_COUNT: int
    ENABLE_DOCS: bool  # /docs, /redoc, /openapi.json : désactivés par défaut (production)


def _bool(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


def load_settings() -> Settings:
    secret = os.getenv("JWT_SECRET", "")
    if len(secret) < 32:
        raise RuntimeError("JWT_SECRET manquant ou trop court (32 caractères minimum).")
    return Settings(
        MONGO_URL=os.getenv("MONGO_URL", "mongodb://localhost:27017/?replicaSet=rs0"),
        DB_NAME=os.getenv("DB_NAME", "washop"),
        JWT_SECRET=secret,
        JWT_EXPIRE_MINUTES=int(os.getenv("JWT_EXPIRE_MINUTES", "720")),
        CORS_ORIGINS=[o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()],
        FRONTEND_URL=os.getenv("FRONTEND_URL", "http://localhost:3000"),
        SMTP_HOST=os.getenv("SMTP_HOST", ""),  # vide = mode développement : le lien part dans les logs
        SMTP_PORT=int(os.getenv("SMTP_PORT", "587")),
        SMTP_USER=os.getenv("SMTP_USER", ""),
        SMTP_PASSWORD=os.getenv("SMTP_PASSWORD", ""),
        SMTP_FROM=os.getenv("SMTP_FROM", "Washop <no-reply@washop.local>"),
        SMTP_STARTTLS=_bool(os.getenv("SMTP_STARTTLS", "true")),
        # Nombre de reverse proxys devant l'app. 0 = pas de proxy (on lit l'IP de la connexion).
        TRUSTED_PROXY_COUNT=int(os.getenv("TRUSTED_PROXY_COUNT", "0")),
        ENABLE_DOCS=_bool(os.getenv("ENABLE_DOCS", "false")),
    )


settings = load_settings()
