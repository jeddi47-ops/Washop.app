"""PDF : facture (règle 5.10) et planche de QR codes (section 6)."""
import datetime as dt
from io import BytesIO

import qrcode
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from .timezones import tz_of

PAYMENT_LABELS = {"cash": "Espèces", "mobile_money": "Mobile money", "card": "Carte", "other": "Autre"}


def money(value) -> str:
    """« 1 248 500 FC » : espace comme séparateur des milliers, suffixe FC. Décimales seulement si nécessaires."""
    number = round(float(value or 0), 2)
    if number == int(number):
        body = f"{int(number):,}"
    else:
        body = f"{number:,.2f}"
    return body.replace(",", " ").replace(".", ",") + " FC"


def _qr_reader(data: str) -> ImageReader:
    buf = BytesIO()
    qrcode.make(data).save(buf, format="PNG")
    buf.seek(0)
    return ImageReader(buf)


def invoice_pdf(business: dict, sale: dict) -> bytes:
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    y = height - 20 * mm

    c.setFont("Helvetica-Bold", 16)
    c.drawString(20 * mm, y, business["name"])
    y -= 6 * mm
    c.setFont("Helvetica", 10)
    for line in (business.get("address"), business.get("phone")):
        if line:
            c.drawString(20 * mm, y, line)
            y -= 5 * mm

    y -= 8 * mm
    c.setFont("Helvetica-Bold", 14)
    c.drawString(20 * mm, y, f"Facture {sale['number']}")
    if sale["status"] == "cancelled":
        c.setFillColorRGB(0.8, 0, 0)
        c.drawRightString(width - 20 * mm, y, "ANNULÉE")
        c.setFillColorRGB(0, 0, 0)
    y -= 6 * mm
    c.setFont("Helvetica", 10)
    created = sale["created_at"]
    if created.tzinfo is None:
        created = created.replace(tzinfo=dt.timezone.utc)
    zone = tz_of(business)
    c.drawString(20 * mm, y, f"Date : {created.astimezone(zone):%d/%m/%Y %H:%M} ({zone.key})")
    y -= 5 * mm
    c.drawString(20 * mm, y, f"Paiement : {PAYMENT_LABELS.get(sale['payment_method'], sale['payment_method'])}")

    y -= 12 * mm
    c.setFont("Helvetica-Bold", 10)
    c.drawString(20 * mm, y, "Article")
    c.drawRightString(120 * mm, y, "Qté")
    c.drawRightString(150 * mm, y, "Prix unit.")
    c.drawRightString(width - 20 * mm, y, "Total ligne")
    y -= 2 * mm
    c.line(20 * mm, y, width - 20 * mm, y)
    c.setFont("Helvetica", 10)
    for item in sale["items"]:
        y -= 6 * mm
        c.drawString(20 * mm, y, item["name"][:50])
        c.drawRightString(120 * mm, y, f"{item['quantity']:g}")
        c.drawRightString(150 * mm, y, money(item["unit_price"]))
        c.drawRightString(width - 20 * mm, y, money(item["line_total"]))

    y -= 10 * mm
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(width - 20 * mm, y, f"Total : {money(sale['total'])}")

    footer = business.get("invoice_footer")
    if footer:
        c.setFont("Helvetica", 9)
        c.drawCentredString(width / 2, 15 * mm, footer[:200])

    c.showPage()
    c.save()
    return buf.getvalue()


def qr_sheet_pdf(items: list[tuple[str, str]]) -> bytes:
    """items : liste de (nom du produit, qr_code). Grille A4, 3 colonnes."""
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    cols, rows = 3, 4
    cell_w, cell_h, qr_size = 63 * mm, 62 * mm, 45 * mm
    for index, (name, code) in enumerate(items):
        pos = index % (cols * rows)
        if index and pos == 0:
            c.showPage()
        col, row = pos % cols, pos // cols
        x = 10 * mm + col * cell_w
        y = height - 15 * mm - (row + 1) * cell_h
        c.drawImage(_qr_reader(code), x + 9 * mm, y + 12 * mm, qr_size, qr_size)
        c.setFont("Helvetica", 9)
        c.drawCentredString(x + cell_w / 2, y + 7 * mm, name[:32])
    c.showPage()
    c.save()
    return buf.getvalue()
