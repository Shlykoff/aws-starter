"""Wiring: builds the application from Settings.

Started with `uvicorn --factory app.main:create_app_from_env`.
"""

import logging
import os
import sys

from fastapi import FastAPI

from app.api import build_api_router
from app.config import ConfigError, Settings, load_settings
from app.decisions import DecisionService
from app.migrate import MigrationError
from app.service import SubmissionService
from app.storage import MessageStore
from app.ui import build_ui_router
from app.validation import SchemaLoadError, SchemaValidator
from app.webhook import WebhookClient

log = logging.getLogger("partner_sim")

_DESCRIPTION = """\
A demo recipient for the messages the main system sends. **Not for production.**

Send a message here with *Try it out* on `POST /v1/submissions`: paste an XML document, put the
key in `X-API-Key`. The inbox at `/` (login required) shows what arrived.
"""


def create_app(settings: Settings) -> FastAPI:
    """Build the application.

    Raises SchemaLoadError if a schema cannot be loaded, and MigrationError if the database
    cannot be brought up to date (or is newer than this code).
    """
    # Loaded once, here. A missing or broken schema stops the start-up, not the first request.
    submission_schema = SchemaValidator(settings.schema_dir / "submission.xsd")
    reply_schema = SchemaValidator(settings.schema_dir / "reply.xsd")
    event_schema = SchemaValidator(settings.schema_dir / "event.xsd")

    store = MessageStore(settings.db_path)
    store.initialize()
    service = SubmissionService(store, submission_schema, reply_schema)

    app = FastAPI(
        title="Partner simulator",
        version="1.0.0",
        description=_DESCRIPTION,
        redoc_url=None,  # one documentation page is enough
    )
    app.include_router(build_api_router(service, settings))
    # The client's side exists only when the webhook is configured (config.py: both or neither).
    decisions = None
    if settings.webhook_url is not None and settings.webhook_token is not None:
        webhook = WebhookClient(settings.webhook_url, settings.webhook_token)
        decisions = DecisionService(store, event_schema, webhook)
    if settings.ui_enabled:
        app.include_router(build_ui_router(store, settings, decisions))
    return app


def create_app_from_env() -> FastAPI:
    """The uvicorn entry point. Any start-up problem ends the process with one clear message."""
    try:
        settings = load_settings(os.environ)
    except ConfigError as exc:
        sys.exit(f"partner-sim cannot start: {exc}")

    logging.basicConfig(
        level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    # httpx logs one line per request, with its full address, at INFO (and more at DEBUG). The
    # address of the sender's webhook has no business in our log, so those loggers stay quiet.
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    try:
        app = create_app(settings)
    except (SchemaLoadError, MigrationError) as exc:
        sys.exit(f"partner-sim cannot start: {exc}")

    log.info(
        "started (UI %s, webhook %s, schemas from %s)",
        "on" if settings.ui_enabled else "off",
        "configured" if settings.webhook_url is not None else "not configured",
        settings.schema_dir,
    )
    return app
