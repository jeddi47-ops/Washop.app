"""Envoi d'email isolé. Sans SMTP_HOST (développement), le contenu part dans les logs."""
import logging
import smtplib
from email.message import EmailMessage

from ..config import settings

logger = logging.getLogger("washop.email")


def send_email(to: str, subject: str, body: str) -> None:
    if not settings.SMTP_HOST:
        logger.warning("SMTP non configuré (développement) : email pour %s non envoyé.\nObjet : %s\n%s", to, subject, body)
        return
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as smtp:
        if settings.SMTP_STARTTLS:
            smtp.starttls()
        if settings.SMTP_USER:
            smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        smtp.send_message(msg)


def send_password_reset_email(to: str, link: str) -> None:
    send_email(
        to,
        "Washop : réinitialisation de votre mot de passe",
        "Pour choisir un nouveau mot de passe (lien valable 30 minutes) :\n"
        f"{link}\n\n"
        "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.",
    )
