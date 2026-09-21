"""Shared test helpers: paths, sample documents, small readers for replies and the database."""

import hashlib
import hmac
import os
import socket
import sqlite3
from pathlib import Path
from xml.sax.saxutils import escape

from fake_webhook import Received
from lxml import etree

from app.replies import REPLY_NS

REPO_ROOT = Path(__file__).resolve().parents[2]
# In Docker both come from the environment (fixtures are mounted read-only, schemas are the
# image's own copy). Outside Docker they are found in the repository.
FIXTURES_DIR = Path(os.environ.get("FIXTURES_DIR") or REPO_ROOT / "contracts" / "fixtures")
SCHEMA_DIR = Path(os.environ.get("SCHEMA_DIR") or REPO_ROOT / "contracts" / "xsd")

API_KEY = "test-api-key-not-a-secret"
UI_USER = "inbox-user"
UI_PASSWORD = "inbox-password-not-a-secret"
UI_AUTH = (UI_USER, UI_PASSWORD)

SAMPLE_ID = "01M30JDSMHY8CRX59V35WV731S"  # the MessageId used by every fixture

WEBHOOK_TOKEN = "unit-test-webhook-token-not-a-secret"
# What a browser adds to a form POST from a page of this application (the test client's host).
SAME_ORIGIN = {"Origin": "http://testserver"}


def ulid(n: int) -> str:
    """A valid ULID made of digits only: 26 characters, all in the allowed alphabet."""
    return f"{n:026d}"


def make_submission(
    *,
    message_id: str = SAMPLE_ID,
    subject: str = "Delivery schedule",
    recipient: str = "Partner OK",
    text: str = "Please confirm the schedule for next week.",
) -> bytes:
    """A valid submission document. Values are XML-escaped, so they can contain < & >."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Submission xmlns="urn:aws-starter:submission:v1" version="1">
  <Header>
    <MessageId>{escape(message_id)}</MessageId>
    <SentAt>2026-09-20T23:29:07.123Z</SentAt>
    <Sender><Name>aws-starter</Name></Sender>
    <Recipient><Name>{escape(recipient)}</Name></Recipient>
  </Header>
  <Content>
    <Subject>{escape(subject)}</Subject>
    <Text>{escape(text)}</Text>
  </Content>
</Submission>
""".encode()


def pad_to_size(document: bytes, size: int) -> bytes:
    """Add an XML comment at the end so that the document is exactly `size` bytes long."""
    document = document.rstrip(b"\n")
    padding = size - len(document) - len(b"<!---->")
    assert padding >= 0, "the document is already longer than the wanted size"
    return document + b"<!--" + b"x" * padding + b"-->"


def reply_fields(body: bytes) -> dict[str, str | None]:
    """The interesting parts of a Reply, read without the application's own code."""
    root = etree.fromstring(body)
    ns = {"r": REPLY_NS}

    def text(path: str) -> str | None:
        return root.findtext(path, namespaces=ns)

    return {
        "message_id": text("r:MessageId"),
        "relates_to": text("r:RelatesTo"),
        "received_at": text("r:ReceivedAt"),
        "status": text("r:Result/r:Status"),
        "code": text("r:Result/r:Code"),
        "description": text("r:Result/r:Description"),
    }


def all_rows(db_path: Path) -> list[sqlite3.Row]:
    """Every row of `messages`, read straight from the file (not through the application)."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute("SELECT * FROM messages ORDER BY id").fetchall()
    finally:
        conn.close()


def signature_is_right(request: Received, token: str) -> bool:
    """Check a received webhook call the way contracts/webhook-api.md says the sender does:
    HMAC-SHA256 with the token over the timestamp text, a dot and the body as received."""
    timestamp = request.headers["x-webhook-timestamp"]
    signed = timestamp.encode("ascii") + b"." + request.body
    expected = "v1=" + hmac.new(token.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return request.headers["x-webhook-signature"] == expected


def closed_port_url() -> str:
    """The address of a port on this computer where nobody listens (connection refused)."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}/hook"


def event_rows(db_path: Path) -> list[sqlite3.Row]:
    """Every row of `decision_events`, read straight from the file."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute("SELECT * FROM decision_events ORDER BY id").fetchall()
    finally:
        conn.close()
