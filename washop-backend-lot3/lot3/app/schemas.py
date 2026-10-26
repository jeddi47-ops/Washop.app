"""Modèles Pydantic (entrées) et fonctions de sérialisation (sorties, filtrage par rôle)."""
from datetime import date
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from .services.timezones import validate_timezone

MAX_MONEY = 1_000_000_000
DeviceType = Literal["caisse", "scanner"]
MotifCode = Literal["erreur_de_saisie", "client_a_change_avis", "produit_abime", "autre"]
USERNAME_PATTERN = r"^[a-z0-9._-]{3,40}$"


def _two_decimals(value: float) -> float:
    return round(float(value), 2)


class RegisterIn(BaseModel):
    business_name: str = Field(min_length=1, max_length=120)
    business_type: str = Field(default="autre", max_length=50)
    currency: str = Field(default="FC", min_length=2, max_length=5)
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)
    password: str = Field(min_length=8, max_length=72)  # bcrypt ne prend que 72 octets
    address: Optional[str] = Field(default=None, max_length=255)
    phone: Optional[str] = Field(default=None, max_length=30)
    timezone: str = Field(default="UTC", max_length=64)
    device_type: DeviceType = "caisse"

    @field_validator("timezone")
    @classmethod
    def _check_tz(cls, v: str) -> str:
        return validate_timezone(v)


class ForgotPasswordIn(BaseModel):
    email: str = Field(max_length=254)


class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    new_password: str = Field(min_length=8, max_length=72)


class LoginIn(BaseModel):
    """Connexion par email (patron) ou par identifiant (caissier). device_type vaut « caisse » par défaut."""
    email: Optional[str] = Field(default=None, max_length=254)
    username: Optional[str] = Field(default=None, max_length=40)
    password: str = Field(max_length=72)
    device_type: DeviceType = "caisse"

    @model_validator(mode="after")
    def _one_login(self):
        if not (self.email or self.username):
            raise ValueError("indiquez un email ou un identifiant")
        return self


class SwitchModeIn(BaseModel):
    device_type: DeviceType


class MotifIn(BaseModel):
    motif_code: Optional[MotifCode] = None
    motif_note: Optional[str] = Field(default=None, max_length=500)


class SellerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=8, max_length=72)
    email: Optional[str] = Field(default=None, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)

    @field_validator("username")
    @classmethod
    def _username(cls, v: str) -> str:
        import re
        v = v.strip().lower()
        if not re.match(USERNAME_PATTERN, v):
            raise ValueError("identifiant : 3 à 40 caractères, lettres minuscules, chiffres, point, tiret ou souligné")
        return v


class UserPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    is_active: Optional[bool] = None
    password: Optional[str] = Field(default=None, min_length=8, max_length=72)


class SettingsIn(BaseModel):
    low_stock_default_threshold: Optional[float] = Field(default=None, ge=0, le=1_000_000)
    expiry_alert_days: Optional[int] = Field(default=None, ge=0, le=3650)
    forecast_alert_days: Optional[int] = Field(default=None, ge=0, le=3650)
    # Vente à crédit : choisi par le propriétaire
    credit_enabled: Optional[bool] = None
    credit_interest_percent: Optional[float] = Field(default=None, ge=0, le=100)   # ex. 15 = 15 % ajoutés au prix
    credit_min_down_percent: Optional[float] = Field(default=None, ge=0, le=100)   # acompte minimum exigé, en % du total
    credit_max_debt: Optional[float] = Field(default=None, ge=0, le=MAX_MONEY)     # dette maximale par client (0 = illimitée)
    phone_country_code: Optional[str] = Field(default=None, pattern=r"^\d{0,4}$")  # ex. « 243 »


class BusinessUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    type: Optional[str] = Field(default=None, max_length=50)
    currency: Optional[str] = Field(default=None, min_length=2, max_length=5)
    address: Optional[str] = Field(default=None, max_length=255)
    phone: Optional[str] = Field(default=None, max_length=30)
    invoice_footer: Optional[str] = Field(default=None, max_length=500)
    settings: Optional[SettingsIn] = None
    timezone: Optional[str] = Field(default=None, max_length=64)

    @field_validator("timezone")
    @classmethod
    def _check_tz(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else validate_timezone(v)


class ProductCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)
    category: Optional[str] = Field(default=None, max_length=60)
    unit: str = Field(default="pièce", max_length=20)
    sale_price: float = Field(ge=0, le=MAX_MONEY)
    purchase_price: float = Field(default=0, ge=0, le=MAX_MONEY)
    initial_quantity: float = Field(default=0, ge=0, le=MAX_MONEY)
    low_stock_threshold: Optional[float] = Field(default=None, ge=0, le=MAX_MONEY)
    expiry_date: Optional[date] = None
    # Un seul code par produit : code-barres existant (barcode) ou QR généré par le serveur (qr, par défaut)
    code_type: Literal["barcode", "qr"] = "qr"
    code: Optional[str] = Field(default=None, max_length=64)

    @field_validator("sale_price", "purchase_price")
    @classmethod
    def _round_money(cls, v: float) -> float:
        return _two_decimals(v)

    @model_validator(mode="after")
    def _check_code(self):
        import re
        if self.code_type == "barcode":
            code = (self.code or "").strip()
            if not re.match(r"^[A-Za-z0-9._-]{1,64}$", code):
                raise ValueError("code-barres obligatoire (lettres, chiffres, point, tiret)")
            self.code = code
        elif self.code:
            raise ValueError("pour un QR, le code est généré par le serveur : ne pas envoyer de code")
        return self


class ProductUpdate(BaseModel):
    """Pas de quantité ici : elle passe par l'ajustement de stock."""
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)
    category: Optional[str] = Field(default=None, max_length=60)
    unit: Optional[str] = Field(default=None, max_length=20)
    sale_price: Optional[float] = Field(default=None, ge=0, le=MAX_MONEY)
    purchase_price: Optional[float] = Field(default=None, ge=0, le=MAX_MONEY)
    low_stock_threshold: Optional[float] = Field(default=None, ge=0, le=MAX_MONEY)
    expiry_date: Optional[date] = None
    # Motif : obligatoire pour un caissier qui change le prix
    motif_code: Optional[MotifCode] = None
    motif_note: Optional[str] = Field(default=None, max_length=500)

    @field_validator("sale_price", "purchase_price")
    @classmethod
    def _round_money(cls, v: Optional[float]) -> Optional[float]:
        return None if v is None else _two_decimals(v)


class StockAdjustIn(BaseModel):
    quantity_change: float = Field(ge=-MAX_MONEY, le=MAX_MONEY)
    type: Literal["restock", "adjustment"]
    reason: Optional[str] = Field(default=None, max_length=255)

    @field_validator("quantity_change")
    @classmethod
    def _non_zero(cls, v: float) -> float:
        if v == 0:
            raise ValueError("la variation doit être différente de 0")
        return v


class QrSheetIn(BaseModel):
    product_ids: List[str] = Field(min_length=1, max_length=500)


class SaleLineIn(BaseModel):
    product_id: str = Field(min_length=1, max_length=64)
    quantity: float = Field(gt=0, le=1_000_000)
    scanned_code: Optional[str] = Field(default=None, max_length=128)  # code scanné, gardé dans la ligne


class CreditIn(BaseModel):
    """Formulaire de vente à crédit. Les intérêts et l'acompte minimum viennent des réglages du propriétaire."""
    customer_name: str = Field(min_length=2, max_length=120)
    customer_id_number: str = Field(min_length=3, max_length=40)   # numéro de pièce d'identité
    customer_phone: str = Field(min_length=6, max_length=30)       # obligatoire : sert aux relances
    frequency: Literal["weekly", "monthly"]
    installment_amount: float = Field(gt=0, le=MAX_MONEY)          # ce que le client paie à chaque échéance
    down_payment: float = Field(default=0, ge=0, le=MAX_MONEY)     # acompte payé tout de suite
    # Total que l'écran a affiché au client : si les réglages ont changé entre-temps, la vente est refusée (409).
    expected_total_due: Optional[float] = Field(default=None, ge=0, le=MAX_MONEY)
    # Mot de passe du propriétaire, seulement si la limite de dette du client est dépassée et que le vendeur est un caissier.
    owner_password: Optional[str] = Field(default=None, max_length=72)

    @field_validator("customer_name", "customer_id_number")
    @classmethod
    def _strip_required(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 2:
            raise ValueError("champ trop court")
        return v

    @field_validator("customer_phone")
    @classmethod
    def _check_phone(cls, v: str) -> str:
        v = v.strip()
        if sum(ch.isdigit() for ch in v) < 6:
            raise ValueError("numéro de téléphone invalide")
        return v


class CreditPaymentIn(BaseModel):
    amount: float = Field(gt=0, le=MAX_MONEY)
    note: Optional[str] = Field(default=None, max_length=200)
    # Même identifiant = même paiement (double clic, coupure réseau) : enregistré une seule fois.
    client_payment_id: Optional[str] = Field(default=None, min_length=8, max_length=64)


class SaleCreateIn(BaseModel):
    items: List[SaleLineIn] = Field(min_length=1, max_length=100)
    payment_method: Literal["cash", "mobile_money", "card", "other", "credit"]
    amount_received: Optional[float] = Field(default=None, ge=0, le=MAX_MONEY)
    # Identifiant unique de la tentative de paiement, créé une fois côté caisse. Même identifiant = même vente.
    client_sale_id: Optional[str] = Field(default=None, min_length=8, max_length=64)
    credit: Optional[CreditIn] = None

    @model_validator(mode="after")
    def _credit_form(self):
        if self.payment_method == "credit" and self.credit is None:
            raise ValueError("le formulaire de crédit est obligatoire")
        if self.payment_method != "credit" and self.credit is not None:
            raise ValueError("le formulaire de crédit ne s'utilise qu'avec le paiement à crédit")
        return self


class CancelIn(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=255)
    motif_code: Optional[MotifCode] = None
    motif_note: Optional[str] = Field(default=None, max_length=500)


def public_user(user: dict) -> dict:
    return {k: v for k, v in user.items() if k not in ("_id", "password_hash", "token_version")}


def public_business(business: dict) -> dict:
    return {k: v for k, v in business.items() if k not in ("_id", "invoice_counter")}


def product_out(product: dict, role: str) -> dict:
    """Règle 5.7 : purchase_price réservé au patron."""
    out = {k: v for k, v in product.items() if k not in ("_id", "business_id")}
    if role != "owner":
        out.pop("purchase_price", None)
    return out


def sale_out(sale: dict, role: str) -> dict:
    """Total_cost, profit et unit_cost réservés au patron (retirés pour un caissier)."""
    out = {k: v for k, v in sale.items() if k not in ("_id", "business_id")}
    if role != "owner":
        out.pop("total_cost", None)
        out.pop("profit", None)
        out["items"] = [{k: v for k, v in item.items() if k != "unit_cost"} for item in sale["items"]]
    return out
