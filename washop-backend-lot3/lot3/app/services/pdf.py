"""PDF : facture (règle 5.10) et planche de QR codes (section 6)."""
import datetime as dt
from io import BytesIO

import qrcode
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from .timezones import tz_of

PAYMENT_LABELS = {"cash": "Espèces", "mobile_money": "Mobile money", "card": "Carte", "other": "Autre", "credit": "Crédit"}


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

    credit = sale.get("credit")
    if credit:
        # Vente à crédit : détail des intérêts, de l'acompte et de l'échéancier (sans numéro de pièce d'identité).
        c.setFont("Helvetica", 10)
        y -= 8 * mm
        c.drawRightString(width - 20 * mm, y, f"Sous-total : {money(credit['subtotal'])}")
        if credit["interest_amount"]:
            y -= 5 * mm
            pct = f"{credit['interest_percent']:g}".replace(".", ",")
            c.drawRightString(width - 20 * mm, y, f"Intérêts ({pct} %) : {money(credit['interest_amount'])}")
    y -= 10 * mm
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(width - 20 * mm, y, f"Total : {money(sale['total'])}")

    if credit:
        c.setFont("Helvetica", 10)
        rhythm = "par semaine" if credit["frequency"] == "weekly" else "par mois"
        first = dt.date.fromisoformat(credit["first_due_date"]).strftime("%d/%m/%Y")
        lines = [
            f"Client : {credit['customer_name']}",
            f"Acompte payé : {money(credit['down_payment'])}",
            f"Reste à payer : {money(credit['balance'])}",
            f"{credit['installments_count']} paiement(s) de {money(credit['installment_amount'])} {rhythm}, le premier le {first}",
        ]
        for text in lines:
            y -= 6 * mm
            c.drawString(20 * mm, y, text[:110])

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


def _plain_money(value, currency: str) -> str:
    number = round(float(value or 0), 2)
    body = f"{int(number):,}" if number == int(number) else f"{number:,.2f}"
    return body.replace(",", " ").replace(".", ",") + f" {currency}"


def purchase_order_pdf(business: dict, supplier: str | None, lines: list[dict], number: str, now: dt.datetime) -> bytes:
    """
    Bon de commande pour un fournisseur : produits, quantités, prix d'achat unitaires, total.
    lines : {name, code, unit, quantity, unit_cost, line_total}. Plusieurs pages si la liste est longue.
    """
    currency = business.get("currency") or "FC"
    zone = tz_of(business)
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    left, right = 20 * mm, width - 20 * mm

    def header() -> float:
        y = height - 20 * mm
        c.setFont("Helvetica-Bold", 16)
        c.drawString(left, y, business["name"])
        y -= 6 * mm
        c.setFont("Helvetica", 10)
        for line in (business.get("address"), business.get("phone")):
            if line:
                c.drawString(left, y, line)
                y -= 5 * mm
        y -= 6 * mm
        c.setFont("Helvetica-Bold", 14)
        c.drawString(left, y, f"Bon de commande {number}")
        y -= 6 * mm
        c.setFont("Helvetica", 10)
        c.drawString(left, y, f"Date : {now.astimezone(zone):%d/%m/%Y}")
        if supplier:
            y -= 5 * mm
            c.drawString(left, y, f"Fournisseur : {supplier[:80]}")
        return y - 10 * mm

    def columns(y: float) -> float:
        c.setFont("Helvetica-Bold", 10)
        c.drawString(left, y, "Produit")
        c.drawRightString(112 * mm, y, "Qté")
        c.drawRightString(145 * mm, y, "Prix unit.")
        c.drawRightString(right, y, "Total")
        y -= 2 * mm
        c.line(left, y, right, y)
        c.setFont("Helvetica", 10)
        return y

    y = columns(header())
    total = 0.0
    for item in lines:
        if y < 35 * mm:  # nouvelle page : on répète l'en-tête et les colonnes
            c.showPage()
            y = columns(header())
        y -= 6 * mm
        name = item["name"] if len(item["name"]) <= 46 else item["name"][:45] + "…"
        c.drawString(left, y, name)
        c.drawRightString(112 * mm, y, f"{item['quantity']:g}")
        c.drawRightString(145 * mm, y, _plain_money(item["unit_cost"], currency))
        c.drawRightString(right, y, _plain_money(item["line_total"], currency))
        total += item["line_total"]

    if y < 40 * mm:
        c.showPage()
        y = header()
    y -= 4 * mm
    c.line(left, y, right, y)
    y -= 8 * mm
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(right, y, f"Total : {_plain_money(total, currency)}")
    y -= 7 * mm
    c.setFont("Helvetica", 9)
    c.drawRightString(right, y, f"{len(lines)} produit(s) · prix d'achat indicatifs, à confirmer avec le fournisseur")
    c.setFont("Helvetica", 8)
    c.drawCentredString(width / 2, 12 * mm, "Document généré par Washop")
    c.showPage()
    c.save()
    return buf.getvalue()
