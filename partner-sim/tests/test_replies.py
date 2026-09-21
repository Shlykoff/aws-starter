"""The Reply builder and the Code/Description rule, tested on their own."""

import re
from datetime import UTC, datetime

import pytest
from helpers import SAMPLE_ID, reply_fields
from lxml import etree

from app.replies import accepted_reply, rejected_reply, rule_violations

NOW = datetime(2026, 9, 21, 10, 11, 12, 345000, tzinfo=UTC)
REJECT_CODES = ["MALFORMED_XML", "SCHEMA_INVALID", "RECIPIENT_REJECTED"]


def validate(reply_schema, xml: str) -> list:
    return reply_schema.validate(etree.fromstring(xml.encode()))


def test_an_accepted_reply_is_valid_and_has_no_code_or_description(reply_schema):
    xml = accepted_reply(NOW, SAMPLE_ID)

    assert validate(reply_schema, xml) == []
    fields = reply_fields(xml.encode())
    assert (fields["status"], fields["code"], fields["description"]) == ("Accepted", None, None)
    assert fields["relates_to"] == SAMPLE_ID
    assert fields["received_at"] == "2026-09-21T10:11:12.345Z"


@pytest.mark.parametrize("code", REJECT_CODES)
def test_a_rejected_reply_is_valid_and_has_code_and_description(reply_schema, code):
    xml = rejected_reply(NOW, SAMPLE_ID, code, "Something is wrong")

    assert validate(reply_schema, xml) == []
    fields = reply_fields(xml.encode())
    assert (fields["status"], fields["code"], fields["description"]) == (
        "Rejected",
        code,
        "Something is wrong",
    )


def test_relates_to_is_left_out_when_there_is_none(reply_schema):
    xml = rejected_reply(NOW, None, "MALFORMED_XML", "not well-formed")

    assert validate(reply_schema, xml) == []
    assert reply_fields(xml.encode())["relates_to"] is None
    assert "RelatesTo" not in xml


def test_the_description_is_cut_to_500_characters(reply_schema):
    xml = rejected_reply(NOW, None, "SCHEMA_INVALID", "x" * 900)

    assert validate(reply_schema, xml) == []
    assert len(reply_fields(xml.encode())["description"]) == 500


def test_text_in_the_description_is_escaped(reply_schema):
    hostile = "value '<script>&</script>' is wrong ]]> \"quoted\""

    xml = rejected_reply(NOW, None, "SCHEMA_INVALID", hostile)

    assert validate(reply_schema, xml) == []
    assert reply_fields(xml.encode())["description"] == hostile  # it survives a round trip
    assert "<script>" not in xml


def test_every_reply_gets_a_new_lower_case_uuid():
    ids = {reply_fields(accepted_reply(NOW, None).encode())["message_id"] for _ in range(20)}

    assert len(ids) == 20
    assert all(re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", i) for i in ids)


def test_received_at_is_written_in_utc_with_z_whatever_the_zone_given():
    from datetime import timedelta, timezone

    in_plus_three = NOW.astimezone(timezone(timedelta(hours=3)))

    fields = reply_fields(accepted_reply(in_plus_three, None).encode())

    assert fields["received_at"] == "2026-09-21T10:11:12.345Z"


# --- rule_violations: the rule that XSD 1.0 cannot express --------------------------------------


def reply_with(result: str) -> etree._Element:
    return etree.fromstring(
        f'<Reply xmlns="urn:aws-starter:reply:v1" version="1"><MessageId>x</MessageId>'
        f"<ReceivedAt>x</ReceivedAt><Result>{result}</Result></Reply>".encode()
    )


@pytest.mark.parametrize(
    "result",
    [
        "<Status>Accepted</Status>",
        "<Status>Rejected</Status><Code>SCHEMA_INVALID</Code><Description>d</Description>",
    ],
    ids=["accepted", "rejected"],
)
def test_the_rule_holds_for_correct_replies(result):
    assert rule_violations(reply_with(result)) == []


@pytest.mark.parametrize(
    "result",
    [
        "<Status>Accepted</Status><Code>SCHEMA_INVALID</Code>",
        "<Status>Accepted</Status><Description>d</Description>",
        "<Status>Rejected</Status>",
        "<Status>Rejected</Status><Code>SCHEMA_INVALID</Code>",
        "<Status>Rejected</Status><Description>d</Description>",
    ],
    ids=[
        "accepted-with-code",
        "accepted-with-description",
        "rejected-without-both",
        "rejected-without-description",
        "rejected-without-code",
    ],
)
def test_the_rule_is_broken_when_code_and_description_do_not_match_the_status(result):
    assert rule_violations(reply_with(result)) != []
