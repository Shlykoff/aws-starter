"""Walk every entry of contracts/fixtures/expected.json: submissions, replies, decision events."""

import json
import re

import pytest
from helpers import FIXTURES_DIR, all_rows, reply_fields
from lxml import etree

from app.replies import rule_violations
from app.xml_input import MalformedXml, parse_xml

EXPECTED = json.loads((FIXTURES_DIR / "expected.json").read_text())
SUBMISSIONS = sorted(EXPECTED["submission"].items())
REPLIES = sorted(EXPECTED["reply"].items())
EVENTS = sorted(EXPECTED["event"].items())

# What expected.json says, as an HTTP status (contracts/README.md).
STATUS_FOR = {"valid": 200, "SCHEMA_INVALID": 422, "MALFORMED_XML": 400}

ULID = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}")


def test_expected_json_and_the_files_on_disk_list_the_same_fixtures():
    for kind in ("submission", "reply", "event"):
        on_disk = {
            f"{folder}/{path.name}"
            for folder in ("valid", "invalid")
            for path in (FIXTURES_DIR / kind / folder).glob("*.xml")
        }
        assert on_disk == set(EXPECTED[kind]), f"{kind}: expected.json and the folders differ"


@pytest.mark.parametrize(("name", "expected"), SUBMISSIONS, ids=[n for n, _ in SUBMISSIONS])
def test_submission_fixture(name, expected, post, assert_valid_reply, settings):
    body = (FIXTURES_DIR / "submission" / name).read_bytes()

    response = post(body)

    assert response.status_code == STATUS_FOR[expected]
    assert_valid_reply(response)
    reply = reply_fields(response.content)

    if expected == "valid":
        assert reply["status"] == "Accepted"
        assert reply["code"] is None
    else:
        assert reply["status"] == "Rejected"
        assert reply["code"] == expected
        assert 0 < len(reply["description"]) <= 500

    # RelatesTo: the submission's MessageId if (and only if) it is a valid ULID. A MessageId in a
    # foreign namespace (the wrong-namespace fixture) is not the submission's MessageId.
    written = re.search(rb"<MessageId>([^<]*)</MessageId>", body)
    in_submission_namespace = b'xmlns="urn:aws-starter:submission:v1"' in body
    if expected == "MALFORMED_XML" or written is None or not in_submission_namespace:
        assert reply["relates_to"] is None
    elif ULID.fullmatch(written.group(1).decode()):
        assert reply["relates_to"] == written.group(1).decode()
    else:
        assert reply["relates_to"] is None

    # Every processed submission is stored once, with the same status as the answer.
    (row,) = all_rows(settings.db_path)
    assert row["http_status"] == response.status_code
    assert row["outcome"] == ("accepted" if expected == "valid" else "rejected")
    assert row["code"] == (None if expected == "valid" else expected)


@pytest.mark.parametrize(("name", "expected"), REPLIES, ids=[n for n, _ in REPLIES])
def test_reply_fixture(name, expected, reply_schema):
    root = etree.fromstring((FIXTURES_DIR / "reply" / name).read_bytes())

    findings = reply_schema.validate(root)

    if expected == "valid":
        assert findings == []
        assert rule_violations(root) == []
    else:
        assert expected == "SCHEMA_INVALID"
        assert findings != []


@pytest.mark.parametrize(("name", "expected"), EVENTS, ids=[n for n, _ in EVENTS])
def test_event_fixture(name, expected, event_schema):
    """What the sender's webhook must decide about the file (contracts/README.md): the same
    parser and validator that build_event() checks our own events with."""
    body = (FIXTURES_DIR / "event" / name).read_bytes()

    if expected == "MALFORMED_XML":  # not well-formed, or a DOCTYPE
        with pytest.raises(MalformedXml):
            parse_xml(body)
        return

    findings = event_schema.validate(parse_xml(body))
    if expected == "valid":
        assert findings == []
    else:
        assert expected == "SCHEMA_INVALID"
        assert findings != []
