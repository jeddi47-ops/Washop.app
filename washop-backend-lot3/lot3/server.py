"""Point d'entrée FastAPI : CORS, routeurs, démarrage (connexion + index)."""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.db import close_db, connect_db, create_indexes, ensure_replica_set
from app.errors import AppError
from app.routers import alerts, audit, auth, business, credits, products, sales, stats, users, ws


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = await connect_db()
    await ensure_replica_set(db)  # erreur claire si MongoDB n'est pas en replica set
    await create_indexes(db)
    yield
    close_db()


_docs = "/docs" if settings.ENABLE_DOCS else None
_redoc = "/redoc" if settings.ENABLE_DOCS else None
_openapi = "/openapi.json" if settings.ENABLE_DOCS else None
app = FastAPI(title="Washop API", version="0.1.0", lifespan=lifespan,
              docs_url=_docs, redoc_url=_redoc, openapi_url=_openapi)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    """Erreurs de validation au format {"detail": "message clair"}."""
    errors = exc.errors()
    first = errors[0] if errors else {}
    field = ".".join(str(part) for part in first.get("loc", []) if part != "body")
    msg = first.get("msg", "données invalides")
    detail = f"Champ invalide « {field} » : {msg}" if field else f"Données invalides : {msg}"
    return JSONResponse(status_code=422, content={"detail": detail})


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError):
    """Erreurs avec code machine : {"detail": "...", "code": "...", ...} (ex. SESSION_REPLACED, PRODUCT_EXISTS)."""
    return JSONResponse(status_code=exc.status_code, content=exc.body(), headers=exc.headers)


for module in (auth, business, products, sales, credits, stats, alerts, users, audit, ws):
    app.include_router(module.router, prefix="/api")


@app.get("/api/health", tags=["system"])
async def health():
    return {"status": "ok"}
