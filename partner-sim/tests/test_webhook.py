"""Signing and sending: the signature of contracts/webhook-api.md, and one POST, no retry."""

import json

import pytest
from fake_webhook import FakeWebhook
from helpers import FIXTURES_DIR, WEBHOOK_TOKEN, closed_port_url, signature_is_right

from app.webhook import WebhookClient, sign

BODY = b"<DecisionEvent>the exact bytes</DecisionEvent>"
VECTOR = json.loads((FIXTURES_DIR / "event" / "signature-vector.json").read_text())


# --- The worked example of the contract ---------------------------------------------------------


def test_the_signature_matches_the_worked_example_of_the_contract():
    body = (FIXTURES_DIR / "event" / VECTOR["bodyFile"]).read_bytes()

    assert sign(VECTOR["token"], VECTOR["timestamp"], body) == VECTOR["signatureHeader"]


def test_the_request_on_the_wire_carries_the_signature_of_the_worked_example(webhook):
    body = (FIXTURES_DIR / "event" / VECTOR["bodyFile"]).read_bytes()
    client = WebhookClient(webhook.url, VECTOR["token"], clock=lambda: int(VECTOR["timestamp"]))

    client.send(body)

    (received,) = webhook.requests
    assert received.headers["x-webhook-timestamp"] == VECTOR["timestamp"]
    assert received.headers["x-webhook-signature"] == VECTOR["signatureHeader"]
    assert received.body == body


# --- The request ---------------------------------------------------------------------------------


def test_the_request_has_the_headers_and_the_body_the_contract_asks_for(webhook):
    result = WebhookClient(webhook.url, WEBHOOK_TOKEN).send(BODY)

    assert result.delivered is True and result.http_status == 200
    (received,) = webhook.requests
    assert received.path == "/hook"
    assert received.body == BODY  # the bytes, exactly
    assert received.headers["content-type"] == "application/xml"
    assert received.headers["user-agent"] == "partner-sim/1"
    assert received.headers["x-webhook-timestamp"].isdigit()  # whole seconds
    assert received.headers["x-webhook-signature"].startswith("v1=")
    assert signature_is_right(received, WEBHOOK_TOKEN)
    assert WEBHOOK_TOKEN not in str(received.headers)  # the token itself never travels


def test_a_signature_made_with_another_token_is_not_the_right_one(webhook):
    WebhookClient(webhook.url, WEBHOOK_TOKEN).send(BODY)

    assert not signature_is_right(webhook.requests[0], WEBHOOK_TOKEN + "x")


def test_every_attempt_gets_a_new_timestamp_and_signature_for_the_same_body(webhook):
    times = iter([1000, 1001])
    client = WebhookClient(webhook.url, WEBHOOK_TOKEN, clock=lambda: next(times))

    client.send(BODY)
    client.send(BODY)

    first, second = webhook.requests
    assert first.body == second.body == BODY
    assert first.headers["x-webhook-timestamp"] == "1000"
    assert second.headers["x-webhook-timestamp"] == "1001"
    assert first.headers["x-webhook-signature"] != second.headers["x-webhook-signature"]
    assert signature_is_right(first, WEBHOOK_TOKEN) and signature_is_right(second, WEBHOOK_TOKEN)


def test_the_timestamp_is_in_whole_seconds(webhook):
    WebhookClient(webhook.url, WEBHOOK_TOKEN, clock=lambda: 1789985732.987).send(BODY)

    assert webhook.requests[0].headers["x-webhook-timestamp"] == "1789985732"


# --- The answer ----------------------------------------------------------------------------------


@pytest.mark.parametrize("status", [200, 201, 204])
def test_any_2xx_answer_is_delivered(webhook, status):
    webhook.status = status

    result = WebhookClient(webhook.url, WEBHOOK_TOKEN).send(BODY)

    assert (result.delivered, result.http_status) == (True, status)


@pytest.mark.parametrize("status", [400, 401, 404, 413, 415, 422, 429, 500, 503])
def test_any_other_answer_is_a_failure_with_its_status(webhook, status):
    webhook.status = status

    result = WebhookClient(webhook.url, WEBHOOK_TOKEN).send(BODY)

    assert (result.delivered, result.http_status) == (False, status)
    assert len(webhook.requests) == 1  # one attempt, no retry


@pytest.mark.parametrize("status", [301, 302, 307, 308])
def test_a_redirect_is_a_failure_and_is_never_followed(webhook, status):
    elsewhere = FakeWebhook()
    try:
        webhook.status = status
        webhook.location = elsewhere.url

        result = WebhookClient(webhook.url, WEBHOOK_TOKEN).send(BODY)

        assert (result.delivered, result.http_status) == (False, status)
        assert elsewhere.requests == []  # the signed request went nowhere else
    finally:
        elsewhere.close()


def test_nobody_answering_is_a_failure_without_a_status():
    result = WebhookClient(closed_port_url(), WEBHOOK_TOKEN).send(BODY)

    assert (result.delivered, result.http_status) == (False, None)


def test_a_slow_answer_runs_into_the_timeout(webhook):
    webhook.delay = 1.0

    result = WebhookClient(webhook.url, WEBHOOK_TOKEN, timeout=0.2).send(BODY)

    assert (result.delivered, result.http_status) == (False, None)


def test_the_timeout_is_8_seconds_by_default():
    assert WebhookClient("http://127.0.0.1:1/", WEBHOOK_TOKEN)._timeout == 8.0
