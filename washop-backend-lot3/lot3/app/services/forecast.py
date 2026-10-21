"""Prévision de rupture (règle 5.8). Fonctions pures."""


def forecast_window_days(age_days: int) -> int:
    """30 jours max, 7 jours min, ou depuis la création si le produit est plus récent."""
    return max(7, min(30, age_days))


def compute_forecast(quantity: float, sold_in_window: float, window_days: int, alert_days: int) -> dict:
    daily = sold_in_window / window_days if window_days > 0 else 0.0
    if daily <= 0:
        return {"daily_sales": 0.0, "days_left": None, "at_risk": False}
    days_left = quantity / daily
    return {
        "daily_sales": round(daily, 2),
        "days_left": round(days_left, 1),
        "at_risk": days_left <= alert_days,
    }
