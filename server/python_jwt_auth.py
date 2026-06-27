"""
Python port of the JWT authentication logic from server/middleware/auth.js.

It is intentionally dependency-free and compatible with jsonwebtoken's default
HS256 tokens:
- JWT secret comes from JWT_SECRET, otherwise app_config.jwt_secret.
- Token payload contains userId and username.
- Tokens expire after 7 days.
- Verification also checks that the user still exists and is active.
- Tokens are refreshed after half of their lifetime has elapsed.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional, Protocol


JWT_ALGORITHM = "HS256"
JWT_SECRET_CONFIG_KEY = "jwt_secret"
TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60


class JWTAuthError(Exception):
    """Base class for JWT authentication failures."""


class MissingToken(JWTAuthError):
    """No bearer token or query token was provided."""


class InvalidToken(JWTAuthError):
    """Token is malformed or has an invalid signature."""


class ExpiredToken(InvalidToken):
    """Token is expired."""


class UserNotFound(JWTAuthError):
    """Token is valid, but the referenced user is missing or inactive."""


class InvalidApiKey(JWTAuthError):
    """Configured API key does not match x-api-key."""


class UserStore(Protocol):
    def get_user_by_id(self, user_id: Any) -> Optional[dict[str, Any]]:
        ...

    def get_first_user(self) -> Optional[dict[str, Any]]:
        ...


class SQLiteAuthStore:
    """Small SQLite adapter for the existing server/database/auth.db schema."""

    def __init__(self, db_path: str | os.PathLike[str] | None = None) -> None:
        if db_path is None:
            db_path = os.environ.get("DATABASE_PATH")
        if db_path is None:
            db_path = Path(__file__).resolve().parent / "database" / "auth.db"
        self.db_path = Path(db_path)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def ensure_app_config(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS app_config (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    def get_config(self, key: str) -> Optional[str]:
        self.ensure_app_config()
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM app_config WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_config(self, key: str, value: str) -> None:
        self.ensure_app_config()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO app_config (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, value),
            )

    def get_or_create_jwt_secret(self) -> str:
        secret = self.get_config(JWT_SECRET_CONFIG_KEY)
        if secret:
            return secret
        secret = secrets.token_hex(64)
        self.set_config(JWT_SECRET_CONFIG_KEY, secret)
        return secret

    def get_user_by_id(self, user_id: Any) -> Optional[dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, username, created_at, last_login, is_system_admin
                FROM users
                WHERE id = ? AND is_active = 1
                """,
                (user_id,),
            ).fetchone()
        return dict(row) if row else None

    def get_first_user(self) -> Optional[dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, username, created_at, last_login, is_system_admin
                FROM users
                WHERE is_active = 1
                LIMIT 1
                """
            ).fetchone()
        return dict(row) if row else None


@dataclass(frozen=True)
class AuthResult:
    user: dict[str, Any]
    claims: dict[str, Any]
    refreshed_token: Optional[str] = None


def resolve_jwt_secret(store: Optional[SQLiteAuthStore] = None) -> str:
    env_secret = os.environ.get("JWT_SECRET")
    if env_secret:
        return env_secret
    return (store or SQLiteAuthStore()).get_or_create_jwt_secret()


def read_jwt_secret_from_db(
    db_path: str | os.PathLike[str] | None = None,
) -> Optional[str]:
    """Read app_config.value where app_config.key = 'jwt_secret'."""

    return SQLiteAuthStore(db_path).get_config(JWT_SECRET_CONFIG_KEY)


def get_or_create_jwt_secret_from_db(
    db_path: str | os.PathLike[str] | None = None,
) -> str:
    """Read app_config.value for jwt_secret, creating it if it does not exist."""

    return SQLiteAuthStore(db_path).get_or_create_jwt_secret()


def _json_bytes(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode((value + padding).encode("ascii"))
    except Exception as exc:
        raise InvalidToken("Invalid base64url encoding") from exc


def _sign(signing_input: bytes, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return _b64url_encode(digest)


def encode_jwt(payload: Mapping[str, Any], secret: str) -> str:
    header = {"alg": JWT_ALGORITHM, "typ": "JWT"}
    header_segment = _b64url_encode(_json_bytes(header))
    payload_segment = _b64url_encode(_json_bytes(payload))
    signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
    signature = _sign(signing_input, secret)
    return f"{header_segment}.{payload_segment}.{signature}"


def decode_jwt(
    token: str,
    secret: str,
    *,
    now: Optional[int] = None,
    leeway_seconds: int = 0,
) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise InvalidToken("JWT must have exactly 3 segments")

    header_segment, payload_segment, signature = parts
    signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
    expected_signature = _sign(signing_input, secret)
    if not hmac.compare_digest(signature, expected_signature):
        raise InvalidToken("Invalid JWT signature")

    try:
        header = json.loads(_b64url_decode(header_segment))
        payload = json.loads(_b64url_decode(payload_segment))
    except json.JSONDecodeError as exc:
        raise InvalidToken("Invalid JWT JSON") from exc

    if header.get("alg") != JWT_ALGORITHM:
        raise InvalidToken(f"Unsupported JWT algorithm: {header.get('alg')!r}")

    current_time = int(time.time()) if now is None else int(now)

    if "nbf" in payload and current_time + leeway_seconds < int(payload["nbf"]):
        raise InvalidToken("JWT is not active yet")

    if "exp" in payload and current_time >= int(payload["exp"]) + leeway_seconds:
        raise ExpiredToken("JWT is expired")

    return payload


def _value_from_user(user: Mapping[str, Any] | Any, key: str) -> Any:
    if isinstance(user, Mapping):
        return user[key]
    return getattr(user, key)


def generate_token(
    user: Mapping[str, Any] | Any,
    secret: str,
    *,
    now: Optional[int] = None,
    ttl_seconds: int = TOKEN_TTL_SECONDS,
) -> str:
    issued_at = int(time.time()) if now is None else int(now)
    payload = {
        "userId": _value_from_user(user, "id"),
        "username": _value_from_user(user, "username"),
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
    }
    return encode_jwt(payload, secret)


def extract_token(
    headers: Mapping[str, str] | None = None,
    query: Mapping[str, str] | None = None,
) -> Optional[str]:
    headers = headers or {}
    query = query or {}

    auth_header = None
    for key, value in headers.items():
        if key.lower() == "authorization":
            auth_header = value
            break

    if auth_header:
        parts = auth_header.split()
        if len(parts) >= 2 and parts[0].lower() == "bearer":
            return parts[1]

    return query.get("token")


def validate_api_key(headers: Mapping[str, str] | None = None) -> None:
    expected_api_key = os.environ.get("API_KEY")
    if not expected_api_key:
        return

    headers = headers or {}
    provided_api_key = None
    for key, value in headers.items():
        if key.lower() == "x-api-key":
            provided_api_key = value
            break

    if provided_api_key != expected_api_key:
        raise InvalidApiKey("Invalid API key")


class JWTAuthenticator:
    def __init__(
        self,
        *,
        secret: Optional[str] = None,
        store: Optional[UserStore] = None,
        sqlite_store: Optional[SQLiteAuthStore] = None,
        is_platform: Optional[bool] = None,
    ) -> None:
        self.sqlite_store = sqlite_store or SQLiteAuthStore()
        self.store = store or self.sqlite_store
        self.secret = secret or resolve_jwt_secret(self.sqlite_store)
        self.is_platform = (
            os.environ.get("VITE_IS_PLATFORM") == "true" if is_platform is None else is_platform
        )

    def authenticate_request(
        self,
        headers: Mapping[str, str] | None = None,
        query: Mapping[str, str] | None = None,
    ) -> AuthResult:
        if self.is_platform:
            user = self.store.get_first_user()
            if not user:
                raise UserNotFound("Platform mode: no active user found")
            return AuthResult(user=user, claims={})

        token = extract_token(headers, query)
        if not token:
            raise MissingToken("Access denied. No token provided.")

        claims = decode_jwt(token, self.secret)
        user = self.store.get_user_by_id(claims.get("userId"))
        if not user:
            raise UserNotFound("Invalid token. User not found.")

        refreshed_token = None
        if "exp" in claims and "iat" in claims:
            now = int(time.time())
            half_life = (int(claims["exp"]) - int(claims["iat"])) / 2
            if now > int(claims["iat"]) + half_life:
                refreshed_token = generate_token(user, self.secret)

        return AuthResult(user=user, claims=claims, refreshed_token=refreshed_token)

    def authenticate_websocket(self, token: Optional[str]) -> Optional[dict[str, Any]]:
        if self.is_platform:
            user = self.store.get_first_user()
            if not user:
                return None
            return {"id": user["id"], "userId": user["id"], "username": user["username"]}

        if not token:
            return None

        try:
            claims = decode_jwt(token, self.secret)
            user = self.store.get_user_by_id(claims.get("userId"))
        except JWTAuthError:
            return None

        if not user:
            return None
        return {"userId": user["id"], "username": user["username"]}
