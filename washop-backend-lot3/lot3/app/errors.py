"""Erreur applicative avec un code machine, au format {"detail": "...", "code": "...", ...}."""


class AppError(Exception):
    def __init__(self, status_code: int, detail: str, code: str | None = None, headers: dict | None = None, **extra):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.code = code
        self.headers = headers
        self.extra = extra

    def body(self) -> dict:
        out = {"detail": self.detail}
        if self.code:
            out["code"] = self.code
        out.update(self.extra)
        return out
