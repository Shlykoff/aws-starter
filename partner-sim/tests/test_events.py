"""Building the DecisionEvent: what is in it, that it is valid, and that free text is safe."""

import logging
import re
from datetime import UTC, datetime

import pytest
from helpers import SAMPLE_ID
from lxml import etree

from app.events import (
    REASON_MAX,
    EventInvalid,
    ReasonRejected,
    build_event,
    clean_reason,
)

NS = {"e": "urn:aws-starter:event:v1"}
MOMENT = datetime(2026, 9, 21, 10, 15, 32, 250000, tzinfo=UTC)

REASONS = [
    None,
    "Out of stock",
    "Нет в наличии",
    "Paid by card & confirmed <today>",
    "<script>alert(1)</script>",
    "]]> and &amp; and &#0;",
    "emoji \N{GRINNING FACE} and tab\tand\nnewline",
    "x" * REASON_MAX,
]


@pytest.mark.parametrize("decision", ["Approved", "Declined"])
@pytest.mark.parametrize("reason", REASONS, ids=lambda r: (r or "none")[:20])
def test_a_built_event_is_valid_and_carries_the_reason_as_text(event_schema, decision, reason):
    built = build_event(event_schema, SAMPLE_ID, decision, reason, MOMENT)

    root = etree.fromstring(built.xml.encode("utf-8"))
    assert event_schema.validate(root) == []  # what the sender's webhook will check too
    assert root.findtext("e:Decision", namespaces=NS) == decision
    # Whatever the reason holds, it comes back out of the XML as the same text.
    assert root.findtext("e:Reason", namespaces=NS) == reason


def test_the_document_is_what_the_schema_wants(event_schema):
    built = build_event(event_schema, SAMPLE_ID, "Approved", "ok", MOMENT)

    root = etree.fromstring(built.xml.encode("utf-8"))
    assert root.tag == "{urn:aws-starter:event:v1}DecisionEvent"
    assert root.get("version") == "1"
    assert [child.tag.split("}")[1] for child in root] == [
        "EventId", "OccurredAt", "RelatesTo", "Decision", "Reason",
    ]  # fmt: skip
    assert root.findtext("e:RelatesTo", namespaces=NS) == SAMPLE_ID
    assert root.findtext("e:OccurredAt", namespaces=NS) == "2026-09-21T10:15:32.250Z"
    assert built.occurred_at == "2026-09-21T10:15:32.250Z"
    assert root.findtext("e:EventId", namespaces=NS) == built.event_id
    assert built.xml.startswith("<?xml version='1.0' encoding='UTF-8'?>")


def test_there_is_no_reason_element_when_there_is_no_reason(event_schema):
    built = build_event(event_schema, SAMPLE_ID, "Approved", None, MOMENT)

    assert "Reason" not in built.xml


def test_every_event_gets_a_fresh_lower_case_uuid4(event_schema):
    ids = {
        build_event(event_schema, SAMPLE_ID, "Approved", None, MOMENT).event_id for _ in range(5)
    }

    assert len(ids) == 5
    for event_id in ids:
        assert re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", event_id
        )


def test_a_reason_is_never_written_as_markup(event_schema):
    built = build_event(event_schema, SAMPLE_ID, "Declined", "<b>&</b>", MOMENT)

    assert "<b>" not in built.xml
    assert "&lt;b&gt;&amp;&lt;/b&gt;" in built.xml


def test_a_document_that_breaks_the_schema_is_refused_and_the_log_holds_no_value(
    event_schema, caplog
):
    caplog.set_level(logging.DEBUG)

    with pytest.raises(EventInvalid):
        build_event(
            event_schema, "RELATES-TO-MARKER-not-a-ulid", "Approved", "REASON-MARKER", MOMENT
        )

    assert "invalid DecisionEvent" in caplog.text  # something was logged...
    assert "RELATES-TO-MARKER" not in caplog.text  # ...but no value from the document
    assert "REASON-MARKER" not in caplog.text


# --- clean_reason: what a person typed, before it goes into the event ----------------------------


def test_surrounding_white_space_is_dropped_and_blank_means_no_reason():
    assert clean_reason("  out of stock \n") == "out of stock"
    assert clean_reason("") is None
    assert clean_reason(" \t\n ") is None
    assert clean_reason("in  the middle") == "in  the middle"


def test_the_limit_is_500_characters_counted_after_stripping():
    assert clean_reason(" " + "я" * 500 + " ") == "я" * 500

    with pytest.raises(ReasonRejected, match="501 characters long; the limit is 500"):
        clean_reason("я" * 501)


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("a\x00b", "U+0000"),
        ("bell\x07", "U+0007"),
        ("\x1f", "U+001F"),  # str.strip() would silently remove this one at the edge
        ("edge\x1c", "U+001C"),
        ("\ufffe", "U+FFFE"),
        ("\ud800", "U+D800"),  # half of a surrogate pair
    ],
)
def test_characters_that_xml_cannot_carry_are_refused_with_a_clear_message(text, code):
    with pytest.raises(ReasonRejected, match=f"XML cannot carry \\({re.escape(code)}\\)"):
        clean_reason(text)


def test_characters_that_xml_can_carry_are_accepted():
    assert clean_reason("tab\there\nnewline\r\nand \x85 \u2028 \N{GRINNING FACE}") is not None
