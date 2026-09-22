"""POST /v1/submissions and GET /healthz: every status code and the order of the checks."""

import re
import secrets
from datetime import UTC, datetime

import pytest
from helpers import (
    API_KEY,
    SAMPLE_ID,
    all_rows,
    make_submission,
    pad_to_size,
    reply_fields,
    ulid,
)

from app.security import same_secret


def chunked(data: bytes, size: int = 1000):
    """A body without a Content-Length header: the client sends it in pieces."""
    return (data[i : i + size] for i in range(0, len(data), size))


# --- Step 1: the key --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {},  # no key at all
        {"X-API-Key": "wrong"},
        {"X-API-Key": ""},
        {"X-API-Key": API_KEY[:-1]},  # a prefix of the real key
        {"X-API-Key": API_KEY + "x"},  # the real key with something added
        {"X-API-Key": API_KEY.upper()},
    ],
    ids=["missing", "wrong", "empty", "prefix", "suffix", "uppercase"],
)
def test_a_missing_or_wrong_key_gets_401_and_no_body(client, settings, headers):
    response = client.post(
        "/v1/submissions",
        content=make_submission(),
        headers={"Content-Type": "application/xml", **headers},
    )

    assert response.status_code == 401
    assert response.content == b""
    assert all_rows(settings.db_path) == []


def test_the_key_is_compared_in_constant_time(post, monkeypatch):
    # The timing itself cannot be observed reliably in a test. What can be pinned down is that
    # the comparison goes through secrets.compare_digest and not through ==.
    calls = []
    real = secrets.compare_digest

    def spy(a, b):
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr(secrets, "compare_digest", spy)

    post(make_submission(), **{"X-API-Key": "wrong"})

    assert (b"wrong", API_KEY.encode()) in calls


def test_same_secret():
    assert same_secret("abc", "abc")
    assert not same_secret("abc", "abd")
    assert not same_secret("abc", "abcd")
    assert same_secret("ключ", "ключ")  # not only ASCII


def test_the_key_is_checked_before_the_content_type(client):
    response = client.post(
        "/v1/submissions",
        content=b"{}",
        headers={"X-API-Key": "wrong", "Content-Type": "application/json"},
    )

    assert response.status_code == 401


# --- Step 2: the content type -----------------------------------------------------------------


@pytest.mark.parametrize(
    "content_type",
    ["text/xml", "application/json", "text/plain", "application/xml+x", "application/xmlx", ""],
)
def test_another_content_type_gets_415_and_no_body(client, settings, content_type):
    headers = {"X-API-Key": API_KEY}
    if content_type:
        headers["Content-Type"] = content_type

    response = client.post("/v1/submissions", content=make_submission(), headers=headers)

    assert response.status_code == 415
    assert response.content == b""
    assert all_rows(settings.db_path) == []


@pytest.mark.parametrize(
    "content_type",
    [
        "application/xml",
        "application/xml; charset=utf-8",
        "application/xml;charset=UTF-8",
        "Application/XML",
    ],
)
def test_application_xml_with_or_without_a_charset_is_accepted(post, content_type):
    assert post(make_submission(), **{"Content-Type": content_type}).status_code == 200


def test_the_content_type_is_checked_before_the_size(client):
    response = client.post(
        "/v1/submissions",
        content=b"x" * 70000,
        headers={"X-API-Key": API_KEY, "Content-Type": "text/plain"},
    )

    assert response.status_code == 415


# --- Step 3: the size -------------------------------------------------------------------------


def test_a_body_of_exactly_the_limit_is_accepted(post):
    body = pad_to_size(make_submission(), 65536)

    assert post(body).status_code == 200


def test_one_byte_over_the_limit_gets_413_and_no_body(post, settings):
    body = pad_to_size(make_submission(), 65537)

    response = post(body)

    assert response.status_code == 413
    assert response.content == b""
    assert all_rows(settings.db_path) == []


def test_the_limit_is_checked_from_the_content_length_header_alone(client):
    # The header announces a huge body; only one byte is actually sent. The refusal must come
    # from the announcement, without waiting for the rest.
    response = client.post(
        "/v1/submissions",
        content=b"x",
        headers={
            "X-API-Key": API_KEY,
            "Content-Type": "application/xml",
            "Content-Length": "1000000000",
        },
    )

    assert response.status_code == 413


def test_the_limit_is_checked_on_the_bytes_read_when_there_is_no_content_length(client):
    # A chunked upload has no Content-Length, so only counting the bytes can catch it.
    response = client.post(
        "/v1/submissions",
        content=chunked(pad_to_size(make_submission(), 70000)),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/xml"},
    )

    assert response.status_code == 413
    assert response.content == b""


def test_the_limit_is_checked_on_the_bytes_read_when_the_header_lies(client):
    response = client.post(
        "/v1/submissions",
        content=pad_to_size(make_submission(), 70000),
        headers={
            "X-API-Key": API_KEY,
            "Content-Type": "application/xml",
            "Content-Length": "10",  # far less than what is really sent
        },
    )

    assert response.status_code == 413


def test_a_chunked_body_of_exactly_the_limit_is_accepted(client):
    response = client.post(
        "/v1/submissions",
        content=chunked(pad_to_size(make_submission(), 65536)),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/xml"},
    )

    assert response.status_code == 200


def test_the_limit_comes_from_the_settings(make_client):
    small = make_client(max_body_bytes=1000)
    headers = {"X-API-Key": API_KEY, "Content-Type": "application/xml"}

    assert (
        small.post(
            "/v1/submissions", content=pad_to_size(make_submission(), 1000), headers=headers
        ).status_code
        == 200
    )
    assert (
        small.post(
            "/v1/submissions", content=pad_to_size(make_submission(), 1001), headers=headers
        ).status_code
        == 413
    )


def test_the_size_is_checked_before_the_document_is_read(post):
    # 70 000 bytes of garbage: too large wins over "not well-formed".
    assert post(b"x" * 70000).status_code == 413


# --- Steps 4-8: what happens to the document --------------------------------------------------


def test_an_accepted_submission(post, settings, assert_valid_reply):
    response = post(
        make_submission(subject="Hello", sender="shlykoff@gmail.com", recipient="Partner OK")
    )

    assert response.status_code == 200
    assert_valid_reply(response)
    reply = reply_fields(response.content)
    assert reply["status"] == "Accepted"
    assert reply["relates_to"] == SAMPLE_ID
    (row,) = all_rows(settings.db_path)
    assert (row["message_id"], row["sender"], row["recipient"], row["subject"]) == (
        SAMPLE_ID,
        "shlykoff@gmail.com",
        "Partner OK",
        "Hello",
    )
    assert (row["outcome"], row["code"], row["http_status"]) == ("accepted", None, 200)
    assert row["reply_xml"] == response.text
    assert row["problems"] == "[]"


def test_an_empty_body_is_malformed(post, assert_valid_reply, settings):
    response = post(b"")

    assert response.status_code == 400
    assert_valid_reply(response)
    assert reply_fields(response.content)["code"] == "MALFORMED_XML"
    (row,) = all_rows(settings.db_path)
    assert row["message_id"] is None  # nothing could be read


def test_bytes_that_are_not_utf_8_are_malformed_and_stored_readably(post, settings):
    response = post(b"\xff\xfe\x00 not xml")

    assert response.status_code == 400
    (row,) = all_rows(settings.db_path)
    assert "\x00" not in row["request_xml"]


def test_a_reply_is_new_every_time(post):
    first = reply_fields(post(make_submission(message_id=ulid(1))).content)
    second = reply_fields(post(make_submission(message_id=ulid(2))).content)

    for reply in (first, second):
        assert re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", reply["message_id"])
    assert first["message_id"] != second["message_id"]


def test_received_at_is_utc_with_z_and_is_now(post):
    before = datetime.now(UTC).replace(microsecond=0)

    received = reply_fields(post(make_submission()).content)["received_at"]

    assert received.endswith("Z")
    moment = datetime.fromisoformat(received)
    assert before <= moment <= datetime.now(UTC)


def test_relates_to_is_left_out_when_the_message_id_is_not_a_ulid(post, assert_valid_reply):
    response = post(make_submission(message_id="not-a-ulid"))

    assert response.status_code == 422
    assert_valid_reply(response)
    assert reply_fields(response.content)["relates_to"] is None


def test_a_ulid_with_a_trailing_newline_is_not_a_ulid(post):
    # A regular expression ending in `$` would let this through.
    response = post(make_submission(message_id=SAMPLE_ID + "\n"))

    assert response.status_code == 422
    assert reply_fields(response.content)["relates_to"] is None


def test_the_findings_are_stored_with_their_lines(post, settings):
    post(make_submission(recipient="Acme #1"))

    (row,) = all_rows(settings.db_path)
    assert row["code"] == "SCHEMA_INVALID"
    assert '"line": 7' in row["problems"]
    assert "pattern" in row["problems"]


# --- Idempotency ------------------------------------------------------------------------------


def test_the_same_message_id_twice_returns_the_identical_answer_and_stores_one_row(post, settings):
    body = make_submission()

    first = post(body)
    second = post(body)

    assert first.status_code == second.status_code == 200
    assert first.content == second.content  # the very same reply, including its own MessageId
    assert len(all_rows(settings.db_path)) == 1


def test_a_different_document_with_the_same_message_id_gets_the_first_answer(post, settings):
    first = post(make_submission(subject="First"))
    second = post(make_submission(subject="Something else entirely"))

    assert second.content == first.content
    (row,) = all_rows(settings.db_path)
    assert row["subject"] == "First"


def test_a_rejection_is_repeated_too(post, settings):
    body = make_submission(subject="Please [reject] this")

    first = post(body)
    second = post(body)

    assert first.status_code == second.status_code == 422
    assert first.content == second.content
    assert len(all_rows(settings.db_path)) == 1


def test_the_idempotency_key_header_is_ignored(post, settings):
    # The recipient deduplicates by the MessageId inside the document, never by the header.
    same_document_other_header = [
        post(make_submission(), **{"Idempotency-Key": "one"}),
        post(make_submission(), **{"Idempotency-Key": "two"}),
    ]
    other_document_same_header = post(
        make_submission(message_id=ulid(7)), **{"Idempotency-Key": SAMPLE_ID}
    )

    assert same_document_other_header[0].content == same_document_other_header[1].content
    assert reply_fields(other_document_same_header.content)["relates_to"] == ulid(7)
    assert len(all_rows(settings.db_path)) == 2


def test_two_different_message_ids_are_two_messages(post, settings):
    post(make_submission(message_id=ulid(1)))
    post(make_submission(message_id=ulid(2)))

    assert len(all_rows(settings.db_path)) == 2


def test_schema_invalid_submissions_are_not_deduplicated(post, settings):
    # Validation comes before the duplicate check (contract steps 3 and 4). So an invalid
    # document is answered every time, and it does not block a corrected one with the same id.
    invalid = make_submission(subject="")

    first = post(invalid)
    second = post(invalid)
    corrected = post(make_submission(subject="Now it is fine"))

    assert (first.status_code, second.status_code) == (422, 422)
    assert first.content != second.content  # answered again, with a new reply MessageId
    assert corrected.status_code == 200
    assert [row["http_status"] for row in all_rows(settings.db_path)] == [422, 422, 200]


def test_a_duplicate_wins_over_the_recipients_own_rules(post, settings):
    accepted = post(make_submission(subject="Fine"))

    # The same MessageId again, now with a subject that would trigger a rule: never gets that far.
    again_with_fail = post(make_submission(subject="[fail]"))
    again_with_reject = post(make_submission(subject="[reject]"))

    assert again_with_fail.content == again_with_reject.content == accepted.content
    assert again_with_fail.status_code == 200
    assert len(all_rows(settings.db_path)) == 1


# --- The recipient's own rules ----------------------------------------------------------------


def test_reject_in_the_subject_gets_422_and_is_stored(post, settings, assert_valid_reply):
    response = post(make_submission(subject="Order [reject] now"))

    assert response.status_code == 422
    assert_valid_reply(response)
    reply = reply_fields(response.content)
    assert (reply["status"], reply["code"]) == ("Rejected", "RECIPIENT_REJECTED")
    assert reply["relates_to"] == SAMPLE_ID
    (row,) = all_rows(settings.db_path)
    assert (row["outcome"], row["code"], row["http_status"]) == (
        "rejected",
        "RECIPIENT_REJECTED",
        422,
    )


def test_fail_in_the_subject_gets_503_with_retry_after_and_is_not_stored(post, settings):
    response = post(make_submission(subject="Try me [fail]"))

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "1"
    assert response.content == b""
    assert all_rows(settings.db_path) == []


def test_after_a_503_the_same_message_is_treated_as_new(post, settings):
    failing = make_submission(subject="[fail]")
    assert post(failing).status_code == 503
    assert post(failing).status_code == 503  # nothing was remembered, so it fails again

    retry = post(make_submission(subject="Now it works"))  # the same MessageId

    assert retry.status_code == 200
    assert reply_fields(retry.content)["status"] == "Accepted"
    assert len(all_rows(settings.db_path)) == 1


def test_the_triggers_are_looked_for_in_the_subject_only(post):
    response = post(make_submission(subject="Hello", text="this text says [reject] and [fail]"))

    assert response.status_code == 200


def test_the_triggers_are_case_sensitive(post):
    assert post(make_submission(message_id=ulid(1), subject="[REJECT] [Fail]")).status_code == 200


def test_reject_wins_when_the_subject_has_both_triggers(post):
    # The contract lists [reject] first; this pins down that reading.
    assert post(make_submission(subject="[fail] and [reject]")).status_code == 422


def test_schema_errors_win_over_the_triggers(post, settings):
    reject = post(make_submission(subject="[reject]", recipient="Acme #1"))
    fail = post(make_submission(message_id=ulid(2), subject="[fail]", recipient="Acme #1"))

    assert reject.status_code == 422
    assert reply_fields(reject.content)["code"] == "SCHEMA_INVALID"
    assert fail.status_code == 422  # not 503
    assert reply_fields(fail.content)["code"] == "SCHEMA_INVALID"
    assert len(all_rows(settings.db_path)) == 2  # the invalid [fail] one is stored


# --- Health and the rest ----------------------------------------------------------------------


def test_healthz_needs_no_key(client):
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_get_on_the_submission_url_is_not_allowed(client):
    assert client.get("/v1/submissions", headers={"X-API-Key": API_KEY}).status_code == 405


@pytest.mark.parametrize(
    "break_the_reply",
    [
        # Breaks reply.xsd itself: a Reply with nothing in it.
        lambda good: '<Reply xmlns="urn:aws-starter:reply:v1" version="1"/>',
        # Valid for reply.xsd but breaks the rule XSD cannot express: Accepted with a Code.
        lambda good: good.replace("</Status>", "</Status><Code>SCHEMA_INVALID</Code>"),
    ],
    ids=["breaks-the-schema", "breaks-the-code-rule"],
)
def test_the_simulator_refuses_to_send_an_invalid_reply(
    make_client, monkeypatch, settings, break_the_reply
):
    # A bug that makes a reply invalid must end as a 500 (loud) and store nothing, never as a
    # reply that the sender would have to treat as a protocol violation.
    import app.service

    real_accepted_reply = app.service.accepted_reply
    monkeypatch.setattr(
        app.service,
        "accepted_reply",
        lambda received_at, relates_to: break_the_reply(
            real_accepted_reply(received_at, relates_to)
        ),
    )
    client = make_client(raise_server_exceptions=False)

    response = client.post(
        "/v1/submissions",
        content=make_submission(),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/xml"},
    )

    assert response.status_code == 500
    assert all_rows(settings.db_path) == []
