"""Configuration: read once from environment variables, validated at start-up.

A wrong or missing value stops the application with one message that lists every problem,
so the person starting it fixes them all at once.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

_LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")


class ConfigError(Exception):
    """The environment does not describe a runnable application."""


@dataclass(frozen=True)
class Settings:
    # repr=False keeps the two secrets out of any log line or traceback that prints Settings.
    api_key: str = field(repr=False)
    ui_enabled: bool
    ui_user: str
    ui_password: str = field(repr=False)
    db_path: Path
    schema_dir: Path
    max_body_bytes: int
    log_level: str


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
    )
