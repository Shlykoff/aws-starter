import dataclasses
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import API_KEY, SCHEMA_DIR, UI_PASSWORD, UI_USER, reply_fields
from lxml import etree

from app.config import Settings
from app.main import create_app
from app.validation import SchemaValidator


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """A fresh database file per test, so tests never see each other's messages.

    (This matters: every valid fixture carries the same MessageId, so with a shared database
    the second one would be answered from the first one's stored answer.)
    """
    return Settings(
        api_key=API_KEY,
        ui_enabled=True,
        ui_user=UI_USER,
        ui_password=UI_PASSWORD,
        db_path=tmp_path / "partner.db",
        schema_dir=SCHEMA_DIR,
        max_body_bytes=65536,
        log_level="INFO",
    )


@pytest.fixture
def make_client(settings: Settings):
    """Build a client, optionally with changed settings (a small size limit, UI off...)."""

    def build(raise_server_exceptions: bool = True, **changes) -> TestClient:
        app = create_app(dataclasses.replace(settings, **changes))
        return TestClient(app, raise_server_exceptions=raise_server_exceptions)

    return build


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


@pytest.fixture(scope="session")
def reply_schema() -> SchemaValidator:
    return SchemaValidator(SCHEMA_DIR / "reply.xsd")


@pytest.fixture
def post(client: TestClient):
    """post(body) sends a submission with the right key and content type."""

    def send(body: bytes, **headers: str):
        all_headers = {"X-API-Key": API_KEY, "Content-Type": "application/xml", **headers}
        return client.post("/v1/submissions", content=body, headers=all_headers)

    return send


@pytest.fixture
def assert_valid_reply(reply_schema: SchemaValidator):
    """Check a response the way the sender will: XML content type, reply.xsd, and the rule that
    Code and Description exist exactly when the status is Rejected (XSD 1.0 cannot say that)."""

    def check(response) -> None:
        assert response.headers["content-type"] == "application/xml; charset=utf-8"
        assert reply_schema.validate(etree.fromstring(response.content)) == []
        fields = reply_fields(response.content)
        rejected = fields["status"] == "Rejected"
        assert (fields["code"] is not None) == rejected
        assert (fields["description"] is not None) == rejected

    return check
