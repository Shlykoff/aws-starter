"""Configuration: read once from environment variables, validated at start-up.

A wrong or missing value stops the application with one message that lists every problem,
so the person starting it fixes them all at once.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

_LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")

# The only hosts a webhook URL may reach over plain http:// (for tests on this computer). The
# token never travels, but the event does, and it must not cross a network unencrypted.
# urlsplit().hostname is lower-case and has no brackets, so [::1] arrives as ::1.
_PLAIN_HTTP_HOSTS = ("localhost", "127.0.0.1", "::1", "host.docker.internal")

# 16 characters is not a strength check, only a guard against a forgotten "test" or "secret".
_WEBHOOK_TOKEN_MIN_LENGTH = 16


class ConfigError(Exception):
    """The environment does not describe a runnable application."""


@dataclass(frozen=True)
class Settings:
    # repr=False keeps the three secrets out of any log line or traceback that prints Settings.
    api_key: str = field(repr=False)
    ui_enabled: bool
    ui_user: str
    ui_password: str = field(repr=False)
    db_path: Path
    schema_dir: Path
    max_body_bytes: int
    log_level: str
    # The client's side: where to send the decisions, and the shared token that signs them.
    # Both are None (no client action) or both are set; load_settings makes sure of it.
    webhook_url: str | None = None
    webhook_token: str | None = field(default=None, repr=False)


def _webhook_url_problem(url: str) -> str | None:
    """Why this URL cannot be used for the webhook, or None when it is fine.

    The URL itself is never put into the message: it could carry a password.
    """
    # A space, a control character or a backslash is a typo, and different parsers read such a
    # URL differently: refuse it instead of guessing which host is meant.
    if any(ch.isspace() or ord(ch) < 32 or ch == "\\" for ch in url):
        return "must not contain spaces, control characters or backslashes"
    try:
        parts = urlsplit(url)
        _ = parts.port  # not used: reading it raises ValueError when the port is not a number
    except ValueError:
        return "is not a valid URL"
    if parts.scheme not in ("http", "https"):
        return "must start with https://"
    if "@" in parts.netloc:
        return "must not contain a user name or password (user:password@)"
    if "#" in url:
        return "must not contain a fragment (#)"
    if not parts.hostname:
        return "must contain a host name"
    if parts.scheme == "http" and parts.hostname not in _PLAIN_HTTP_HOSTS:
        return (
            "must use https:// (http:// is allowed only for localhost, 127.0.0.1, [::1] "
            "and host.docker.internal)"
        )
    return None


def load_settings(env: Mapping[str, str]) -> Settings:
    """Build Settings from `env` (normally os.environ) or raise ConfigError."""
    problems: list[str] = []

    def text(name: str) -> str:
        return env.get(name, "").strip()

    # The API key has no default anywhere: a shared default would be a published secret.
    api_key = env.get("PARTNER_API_KEY", "")
    if not api_key.strip():
        problems.append("PARTNER_API_KEY is required (the key that senders put in X-API-Key)")

    ui_enabled_text = text("UI_ENABLED").lower() or "true"
    if ui_enabled_text not in ("true", "false"):
        problems.append("UI_ENABLED must be 'true' or 'false'")
    ui_enabled = ui_enabled_text != "false"

    ui_user = env.get("UI_USER", "")
    ui_password = env.get("UI_PASSWORD", "")
    if ui_enabled:
        if not ui_user.strip():
            problems.append("UI_USER is required unless UI_ENABLED=false")
        if not ui_password.strip():
            problems.append("UI_PASSWORD is required unless UI_ENABLED=false")

    max_body_text = text("MAX_BODY_BYTES") or "65536"
    max_body_bytes = 0
    try:
        max_body_bytes = int(max_body_text)
    except ValueError:
        pass
    if max_body_bytes < 1:
        problems.append("MAX_BODY_BYTES must be a whole number of at least 1")

    log_level = (text("LOG_LEVEL") or "INFO").upper()
    if log_level not in _LOG_LEVELS:
        problems.append(f"LOG_LEVEL must be one of {', '.join(_LOG_LEVELS)}")

    # The client's side is optional, but a half-configured one is a mistake: a URL without the
    # token could not sign, a token without the URL has nowhere to send. So both or neither.
    webhook_url = text("WEBHOOK_URL")
    webhook_token = env.get("WEBHOOK_TOKEN", "")
    has_url = bool(webhook_url)
    has_token = bool(webhook_token.strip())
    if has_url != has_token:
        problems.append(
            "WEBHOOK_URL and WEBHOOK_TOKEN must be set together or both left empty "
            f"({'only WEBHOOK_URL' if has_url else 'only WEBHOOK_TOKEN'} is set)"
        )
    if has_url:
        url_problem = _webhook_url_problem(webhook_url)
        if url_problem:
            problems.append(f"WEBHOOK_URL {url_problem}")
    if has_token:
        # Not stripped silently: a space at the end would make the key differ from the sender's
        # and every event would be answered 401 for no visible reason.
        if webhook_token != webhook_token.strip():
            problems.append("WEBHOOK_TOKEN must not start or end with a space")
        if len(webhook_token) < _WEBHOOK_TOKEN_MIN_LENGTH:
            problems.append(
                f"WEBHOOK_TOKEN must be at least {_WEBHOOK_TOKEN_MIN_LENGTH} characters"
            )

    if problems:
        raise ConfigError("invalid configuration:\n  - " + "\n  - ".join(problems))

    return Settings(
        api_key=api_key,
        ui_enabled=ui_enabled,
        ui_user=ui_user,
        ui_password=ui_password,
        db_path=Path(text("DB_PATH") or "/data/partner.db"),
        schema_dir=Path(text("SCHEMA_DIR") or "/app/schemas"),
        max_body_bytes=max_body_bytes,
        log_level=log_level,
        webhook_url=webhook_url or None,
        webhook_token=webhook_token if has_token else None,
    )
