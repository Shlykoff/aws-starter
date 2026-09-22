"""The client's side: Approve / Decline on a message page, "Send again", and the cross-site guard.

The application under test sends real HTTP to a fake webhook on a local port (see
fake_webhook.py), so what the sender would receive is checked byte for byte.
"""

import logging
import re
import sqlite3

import pytest
from helpers import (
    API_KEY,
    SAME_ORIGIN,
    SAMPLE_ID,
    UI_AUTH,
    WEBHOOK_TOKEN,
    all_rows,
    closed_port_url,
    event_rows,
    make_submission,
    signature_is_right,
    ulid,
)
from lxml import etree

from app.decisions import DecisionService
from app.events import EventInvalid, build_event
from app.models import NewDecisionEvent, NewMessage
from app.storage import MessageStore
from app.timeutil import utc_now
from app.webhook import SendResult, WebhookClient

NS = {"e": "urn:aws-starter:event:v1"}


def accept(
    client, message_id: str = SAMPLE_ID, subject: str = "Delivery schedule", status: int = 200
) -> None:
    """Deliver a submission to the partner API. The stored row gets the next id (1, 2...)."""
    response = client.post(
        "/v1/submissions",
        content=make_submission(message_id=message_id, subject=subject),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/xml"},
    )
    assert response.status_code == status


def press(client, decision="Approved", reason="", message=1, headers=SAME_ORIGIN, **kwargs):
    """What the browser does when the person presses Approve or Decline."""
    return client.post(
        f"/messages/{message}/decision",
        data={"decision": decision, "reason": reason},
        auth=UI_AUTH,
        headers=headers,
        follow_redirects=False,
        **kwargs,
    )


def resend(client, event_id, message=1, headers=SAME_ORIGIN):
    return client.post(
        f"/messages/{message}/decision/{event_id}/resend",
        auth=UI_AUTH,
        headers=headers,
        follow_redirects=False,
    )


def page(client, message=1, query="") -> str:
    return client.get(f"/messages/{message}{query}", auth=UI_AUTH).text


def event_id_of(response) -> str:
    """The event id a 303 redirect points at."""
    return re.fullmatch(r"/messages/\d+\?event=([0-9a-f-]{36})", response.headers["location"])[1]


@pytest.fixture
def ready(webhook_client):
    """An application with the client's side on, and one accepted message (row 1)."""
    accept(webhook_client)
    return webhook_client


# --- Not configured, and messages that get no action ---------------------------------------------


def test_without_the_webhook_settings_the_page_offers_no_action(client, webhook, settings):
    accept(client)

    text = page(client)

    assert "Client action" in text and "The webhook is not configured" in text
    # No decision form (the header's own "Clear" form is unrelated and always there).
    assert 'action="/messages/1/decision"' not in text and "Approve" not in text
    response = press(client)
    assert response.status_code == 409
    assert "The webhook is not configured" in response.text
    assert webhook.requests == [] and event_rows(settings.db_path) == []


@pytest.mark.parametrize(
    "subject", ["[reject] no thanks", ""], ids=["rejected-by-the-recipient", "schema-invalid"]
)
def test_a_rejected_message_gets_no_action(ready, webhook, settings, subject):
    accept(ready, message_id=ulid(2), subject=subject, status=422)  # row 2

    text = page(ready, message=2)
    response = press(ready, message=2)

    assert "Client action" not in text and "Approve" not in text
    assert response.status_code == 409 and "Only an accepted message" in response.text
    assert webhook.requests == [] and event_rows(settings.db_path) == []


def test_a_message_that_does_not_exist_is_a_404(ready, webhook):
    assert press(ready, message=99).status_code == 404
    assert resend(ready, "3f0c6b1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c", message=99).status_code == 404
    assert webhook.requests == []


def test_the_page_shows_the_buttons_for_an_accepted_message(ready):
    text = page(ready)

    assert 'action="/messages/1/decision"' in text
    assert 'name="decision" value="Approved"' in text and "Approve</button>" in text
    assert 'name="decision" value="Declined"' in text and "Decline</button>" in text
    assert 'name="reason"' in text
    assert WEBHOOK_TOKEN not in text  # nothing about the token on the page


# --- Approve and Decline -------------------------------------------------------------------------


def test_approve_sends_a_valid_signed_event_and_the_page_reports_it(
    ready, webhook, event_schema, settings
):
    response = press(ready, "Approved")

    assert response.status_code == 303
    event_id = event_id_of(response)
    (received,) = webhook.requests
    root = etree.fromstring(received.body)
    assert event_schema.validate(root) == []
    assert root.findtext("e:EventId", namespaces=NS) == event_id
    assert root.findtext("e:RelatesTo", namespaces=NS) == SAMPLE_ID  # the ULID, not the row id
    assert root.findtext("e:Decision", namespaces=NS) == "Approved"
    assert root.find("e:Reason", NS) is None
    assert signature_is_right(received, WEBHOOK_TOKEN)
    (row,) = event_rows(settings.db_path)
    assert (row["state"], row["attempts"], row["last_status"]) == ("delivered", 1, 200)
    assert row["event_xml"].encode("utf-8") == received.body  # the stored bytes are the sent bytes
    assert row["last_attempt_at"] is not None

    text = page(ready, query=f"?event={event_id}")
    assert "Sent: the sender answered 200" in text
    assert event_id in text and "delivered" in text


def test_decline_sends_the_reason_in_the_event(ready, webhook):
    press(ready, "Declined", reason="  Нет в наличии & <очень> жаль \n")

    root = etree.fromstring(webhook.requests[0].body)
    assert root.findtext("e:Decision", namespaces=NS) == "Declined"
    assert root.findtext("e:Reason", namespaces=NS) == "Нет в наличии & <очень> жаль"
    text = page(ready)
    assert "Нет в наличии &amp; &lt;очень&gt; жаль" in text  # shown as text


def test_a_blank_reason_leaves_the_reason_element_out(ready, webhook):
    press(ready, "Declined", reason="   ")

    assert b"Reason" not in webhook.requests[0].body


def test_a_reason_of_exactly_500_characters_goes_through(ready, webhook):
    response = press(ready, "Declined", reason="я" * 500)

    assert response.status_code == 303
    assert (
        etree.fromstring(webhook.requests[0].body).findtext("e:Reason", namespaces=NS) == "я" * 500
    )


@pytest.mark.parametrize(
    ("status", "sentence"),
    [(401, "Not delivered: HTTP 401"), (500, "Not delivered: HTTP 500"), (404, "HTTP 404")],
)
def test_a_refusal_of_the_sender_is_reported_and_stored(ready, webhook, settings, status, sentence):
    webhook.status = status

    response = press(ready)

    assert response.status_code == 303  # the click itself worked; the outcome is on the page
    assert sentence in page(ready, query=f"?event={event_id_of(response)}")
    (row,) = event_rows(settings.db_path)
    assert (row["state"], row["attempts"], row["last_status"]) == ("failed", 1, status)
    assert len(webhook.requests) == 1  # no automatic retry


def test_nobody_answering_is_reported_and_stored_without_a_status(make_client, settings):
    client = make_client(webhook_url=closed_port_url(), webhook_token=WEBHOOK_TOKEN)
    accept(client)

    response = press(client)

    assert "Not delivered: no answer" in page(client, query=f"?event={event_id_of(response)}")
    (row,) = event_rows(settings.db_path)
    assert (row["state"], row["attempts"], row["last_status"]) == ("failed", 1, None)


def test_the_outcome_line_is_only_shown_for_an_event_of_this_message(ready):
    press(ready)

    assert "Sent:" not in page(ready, query="?event=00000000-0000-4000-8000-000000000000")
    assert "Sent:" not in page(ready)


# --- Send again ----------------------------------------------------------------------------------


def test_send_again_sends_the_same_event_and_the_same_bytes(ready, webhook, settings):
    event_id = event_id_of(press(ready, "Declined", reason="Out of stock"))

    response = resend(ready, event_id)

    assert response.status_code == 303 and event_id_of(response) == event_id
    first, second = webhook.requests
    assert first.body == second.body  # the same bytes, so the same EventId
    assert signature_is_right(second, WEBHOOK_TOKEN)
    (row,) = event_rows(settings.db_path)  # still one event, sent twice
    assert (row["state"], row["attempts"]) == ("delivered", 2)
    assert row["event_id"] == event_id
    assert "Send again" in page(ready)


def test_send_again_after_a_failure_can_deliver_the_event(ready, webhook, settings):
    webhook.status = 503
    event_id = event_id_of(press(ready))
    webhook.status = 200

    resend(ready, event_id)

    (row,) = event_rows(settings.db_path)
    assert (row["state"], row["attempts"], row["last_status"]) == ("delivered", 2, 200)


def test_the_state_is_the_result_of_the_last_attempt(ready, webhook, settings):
    event_id = event_id_of(press(ready))
    webhook.status = 500

    resend(ready, event_id)

    (row,) = event_rows(settings.db_path)
    assert (row["state"], row["attempts"], row["last_status"]) == ("failed", 2, 500)


def test_an_event_of_another_message_cannot_be_sent_from_this_address(ready, webhook):
    accept(ready, message_id=ulid(2))  # row 2
    event_id = event_id_of(press(ready, message=1))

    response = resend(ready, event_id, message=2)

    assert response.status_code == 404
    assert len(webhook.requests) == 1  # only the first press sent something


def test_an_unknown_event_is_a_404_and_sends_nothing(ready, webhook):
    assert resend(ready, "3f0c6b1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c").status_code == 404
    assert resend(ready, "not-an-event-id").status_code == 404
    assert webhook.requests == []


# --- A new press is a new event ------------------------------------------------------------------


def test_every_press_is_a_new_event_and_the_newest_is_listed_first(ready, webhook, settings):
    press(ready, "Approved")
    press(ready, "Approved")
    press(ready, "Declined", reason="Changed my mind")

    rows = event_rows(settings.db_path)
    assert [row["decision"] for row in rows] == ["Approved", "Approved", "Declined"]
    assert len({row["event_id"] for row in rows}) == 3  # three EventIds
    sent_ids = {
        etree.fromstring(r.body).findtext("e:EventId", namespaces=NS) for r in webhook.requests
    }
    assert sent_ids == {row["event_id"] for row in rows}
    assert [row["occurred_at"] for row in rows] == sorted(row["occurred_at"] for row in rows)
    text = page(ready)
    assert text.index("Changed my mind") < text.index(rows[0]["event_id"])  # newest row on top


def test_the_events_are_still_there_after_a_restart(ready, make_client, webhook):
    press(ready, "Declined", reason="Out of stock")

    text = page(make_client(webhook_url=webhook.url, webhook_token=WEBHOOK_TOKEN))

    assert "Out of stock" in text and "delivered" in text


# --- What is refused before anything is sent -----------------------------------------------------


@pytest.mark.parametrize("decision", ["", "Approve", "approved", "Maybe", "Approved "])
def test_an_unknown_decision_is_refused(ready, webhook, settings, decision):
    response = press(ready, decision)

    assert response.status_code == 400 and "Choose Approve or Decline" in response.text
    assert webhook.requests == [] and event_rows(settings.db_path) == []


def test_a_form_without_a_decision_is_refused(ready, webhook):
    response = ready.post(
        "/messages/1/decision", data={"reason": "x"}, auth=UI_AUTH, headers=SAME_ORIGIN
    )

    assert response.status_code == 400 and webhook.requests == []


def test_a_reason_over_500_characters_is_refused_with_a_message_and_kept_in_the_field(
    ready, webhook, settings
):
    response = press(ready, "Declined", reason="я" * 501)

    assert response.status_code == 422
    assert "The reason is 501 characters long; the limit is 500." in response.text
    assert f'value="{"я" * 501}"' in response.text  # what was typed is not lost
    assert webhook.requests == [] and event_rows(settings.db_path) == []


@pytest.mark.parametrize(("character", "code"), [("\x00", "U+0000"), ("\x07", "U+0007")])
def test_a_control_character_in_the_reason_is_refused_with_a_message(
    ready, webhook, settings, character, code
):
    response = press(ready, "Declined", reason=f"bell{character}here")

    assert response.status_code == 422
    assert f"a character that XML cannot carry ({code})" in response.text
    assert webhook.requests == [] and event_rows(settings.db_path) == []


def test_a_hostile_reason_is_shown_as_text_never_as_markup(ready, webhook):
    hostile = "<script>alert('x')</script><img src=x onerror=alert(1)>"
    press(ready, "Declined", reason=hostile)
    refused = press(ready, "Declined", reason='"><script>alert(2)</script>' + "x" * 500)

    for text in (page(ready), refused.text):
        # our own one script (the local time) and nothing that came from the reason
        assert "<img" not in text and text.count("<script") == 1
    assert "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;" in page(ready)
    assert etree.fromstring(webhook.requests[0].body).findtext("e:Reason", namespaces=NS) == hostile


def test_the_form_must_be_a_urlencoded_form(ready, webhook):
    response = ready.post(
        "/messages/1/decision", json={"decision": "Approved"}, auth=UI_AUTH, headers=SAME_ORIGIN
    )

    assert response.status_code == 415 and webhook.requests == []


def test_a_field_that_appears_twice_is_refused(ready, webhook):
    response = ready.post(
        "/messages/1/decision",
        content="decision=Approved&decision=Declined",
        headers={**SAME_ORIGIN, "Content-Type": "application/x-www-form-urlencoded"},
        auth=UI_AUTH,
    )

    assert response.status_code == 400 and webhook.requests == []


def test_a_huge_form_is_refused(ready, webhook):
    response = press(ready, "Declined", reason="x" * 20000)

    assert response.status_code == 413 and webhook.requests == []


def test_the_message_of_a_broken_event_is_refused_and_nothing_is_sent(ready, webhook, settings):
    # An accepted row whose MessageId is not a ULID cannot happen through the API: it is a way
    # to make the built event break event.xsd (RelatesTo), which is the bug this guards against.
    MessageStore(settings.db_path).add(_accepted("NOT-A-ULID"))

    response = press(ready, message=2)

    assert response.status_code == 500 and "Nothing was sent" in response.text
    assert webhook.requests == [] and event_rows(settings.db_path) == []


# --- The login and the cross-site guard ---------------------------------------------------------


def test_the_actions_need_the_login(ready, webhook):
    for auth in (None, ("inbox-user", "wrong")):
        press_response = ready.post(
            "/messages/1/decision",
            data={"decision": "Approved"},
            auth=auth,
            headers=SAME_ORIGIN,
        )
        assert press_response.status_code == 401
        resend_response = ready.post(
            "/messages/1/decision/x/resend", auth=auth, headers=SAME_ORIGIN
        )
        assert resend_response.status_code == 401
    assert webhook.requests == []


FOREIGN = [
    {"Origin": "http://evil.example"},
    {"Origin": "https://evil.example"},
    {"Origin": "null"},  # sandboxed pages, and pages with Referrer-Policy: no-referrer
    {"Origin": "http://testserver.evil.example"},  # starts like ours, is not ours
    {"Origin": "http://testserver:9999"},  # another port is another origin
    {"Origin": "http://user@testserver"},
    {"Referer": "http://evil.example/page"},
    {"Referer": "http://testserver.evil.example/messages/1"},
    {},  # no Origin and no Referer: we cannot tell where it came from
    {"Origin": "http://testserver", "Sec-Fetch-Site": "cross-site"},
    {"Origin": "http://testserver", "Sec-Fetch-Site": "same-site"},
    {"Referer": "http://testserver/messages/1", "Sec-Fetch-Site": "cross-site"},
    {"Origin": "http://evil.example", "Referer": "http://testserver/messages/1"},
]


@pytest.mark.parametrize("headers", FOREIGN, ids=[str(sorted(h.items())) for h in FOREIGN])
def test_a_cross_site_post_is_refused_and_sends_nothing(ready, webhook, settings, headers):
    event_id = event_id_of(press(ready))  # one legitimate event to try to send again
    webhook.requests.clear()

    pressed = press(ready, "Declined", headers=headers)
    resent = resend(ready, event_id, headers=headers)

    for response in (pressed, resent):
        assert response.status_code == 403
        assert response.headers["content-type"].startswith("text/plain")
        assert "did not come from a page of this address" in response.text
    assert webhook.requests == []  # nothing was sent...
    assert len(event_rows(settings.db_path)) == 1  # ...and nothing was stored


GENUINE = [
    {"Origin": "http://testserver"},
    {"Origin": "http://TESTSERVER"},  # host names are not case sensitive
    {"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"},
    {"Origin": "http://testserver", "Sec-Fetch-Site": "none"},
    {"Referer": "http://testserver/messages/1"},  # no Origin: the Referer is looked at
    {"Origin": "https://testserver"},  # behind a tunnel the browser used https: only host counts
]


@pytest.mark.parametrize("headers", GENUINE, ids=[str(sorted(h.items())) for h in GENUINE])
def test_a_post_from_a_page_of_this_address_is_accepted(ready, webhook, headers):
    assert press(ready, headers=headers).status_code == 303
    assert len(webhook.requests) == 1


def test_reading_a_page_needs_no_origin(ready):
    assert ready.get("/messages/1", auth=UI_AUTH).status_code == 200


def test_the_forms_of_the_page_are_allowed_by_the_content_security_policy(ready):
    policy = ready.get("/messages/1", auth=UI_AUTH).headers["content-security-policy"]

    assert "form-action 'self'" in policy and "script-src 'sha256-" in policy


# --- The inbox column ----------------------------------------------------------------------------


def test_the_inbox_shows_the_newest_decision_and_how_many_events_there_are(ready, webhook):
    accept(ready, message_id=ulid(2))
    press(ready, "Approved")
    press(ready, "Declined", reason="Changed my mind")
    webhook.status = 500
    press(ready, "Approved", message=2)

    text = ready.get("/", auth=UI_AUTH).text

    assert "<th>Client</th>" in text
    row_of_message_1 = text[text.index("/messages/1") :]
    assert '<span class="badge bad">Declined</span>' in row_of_message_1
    assert "2 events" in row_of_message_1
    row_of_message_2 = text[text.index("/messages/2") : text.index("/messages/1")]
    assert '<span class="badge ok">Approved</span>' in row_of_message_2
    assert "not delivered" in row_of_message_2 and "events" not in row_of_message_2


def test_a_message_without_events_shows_a_dash(ready):
    text = ready.get("/", auth=UI_AUTH).text

    assert "Approved" not in text and "Declined" not in text


def test_with_the_interface_off_there_is_no_action_at_all(make_client, webhook):
    client = make_client(
        ui_enabled=False,
        ui_user="",
        ui_password="",
        webhook_url=webhook.url,
        webhook_token=WEBHOOK_TOKEN,
    )
    accept(client)

    assert press(client).status_code == 404 and webhook.requests == []


# --- Admin: wiping test data out of a running instance --------------------------------------------


def test_admin_reset_needs_the_login(ready, settings):
    press(ready, "Declined", reason="Out of stock")  # something to wipe, and to confirm it wasn't

    response = ready.post("/admin/reset", headers=SAME_ORIGIN)

    assert response.status_code == 401
    assert all_rows(settings.db_path) != [] and event_rows(settings.db_path) != []


def test_admin_reset_is_refused_cross_site(ready, settings):
    press(ready, "Declined", reason="Out of stock")

    response = ready.post("/admin/reset", auth=UI_AUTH, headers={"Origin": "http://evil.example"})

    assert response.status_code == 403
    assert all_rows(settings.db_path) != [] and event_rows(settings.db_path) != []


def test_admin_reset_clears_both_tables(ready, settings):
    # A message with a decision event: if reset() deleted messages before decision_events, the
    # foreign key (foreign_keys=ON) would raise IntegrityError and this call would fail loudly.
    press(ready, "Declined", reason="Out of stock")
    assert all_rows(settings.db_path) != [] and event_rows(settings.db_path) != []

    response = ready.post("/admin/reset", auth=UI_AUTH, headers=SAME_ORIGIN, follow_redirects=False)

    # 303 back to the inbox, like the header's "Clear" button (a plain form post) lands on.
    assert response.status_code == 303 and response.headers["location"] == "/"
    assert all_rows(settings.db_path) == [] and event_rows(settings.db_path) == []
    assert "Nothing has arrived yet" in ready.get("/", auth=UI_AUTH).text
    assert ready.get("/messages/1", auth=UI_AUTH).status_code == 404


# --- Secrets: not in the log, not in the database ------------------------------------------------


def test_the_token_the_signature_and_the_reason_never_reach_the_log(ready, webhook, caplog):
    caplog.set_level(logging.DEBUG)
    event_id = event_id_of(press(ready, "Declined", reason="REASON-MARKER-4711"))
    webhook.status = 500
    resend(ready, event_id)
    press(ready, "Declined", reason="x", headers={"Origin": "http://evil.example"})

    assert "decision event delivered" in caplog.text  # the log is not simply empty
    assert "decision event not delivered" in caplog.text
    assert "cross-site" in caplog.text
    secrets = [WEBHOOK_TOKEN, "REASON-MARKER-4711", "<DecisionEvent", SAMPLE_ID]
    secrets += [request.headers["x-webhook-signature"] for request in webhook.requests]
    for secret in secrets:
        assert secret not in caplog.text


def test_the_token_and_the_signature_are_not_stored(ready, webhook, settings):
    press(ready)
    resend(ready, event_rows(settings.db_path)[0]["event_id"])

    stored = " ".join(str(value) for row in event_rows(settings.db_path) for value in tuple(row))
    assert WEBHOOK_TOKEN not in stored
    for request in webhook.requests:
        assert request.headers["x-webhook-signature"] not in stored
    assert WEBHOOK_TOKEN not in settings.db_path.read_bytes().decode("latin-1")


# --- The service on its own ----------------------------------------------------------------------


def _accepted(message_id: str) -> NewMessage:
    return NewMessage(
        received_at="2026-09-21T10:11:12.000Z", message_id=message_id, sender="s@example.com",
        recipient="r", subject="s", outcome="accepted", code=None, http_status=200,
        request_xml="<a/>", reply_xml="<b/>", problems=[],
    )  # fmt: skip


@pytest.fixture
def store(tmp_path):
    store = MessageStore(tmp_path / "service.db")
    store.initialize()
    store.add(_accepted(SAMPLE_ID))
    return store


def test_the_event_is_stored_as_pending_before_it_is_sent(store, event_schema):
    class Spy:
        def send(self, body: bytes) -> SendResult:
            self.states_during_the_send = [event.state for event in store.events_of(1)]
            return SendResult(delivered=True, http_status=200)

    spy = Spy()
    service = DecisionService(store, event_schema, spy)

    service.decide(store.get(1), "Approved", None)

    assert spy.states_during_the_send == ["pending"]  # a crash in the send cannot lose it
    assert [event.state for event in store.events_of(1)] == ["delivered"]


def test_resend_keeps_the_event_and_the_body_but_signs_again(store, event_schema, webhook):
    times = iter([2000, 2001])
    client = WebhookClient(webhook.url, WEBHOOK_TOKEN, clock=lambda: next(times))
    service = DecisionService(store, event_schema, client)

    first = service.decide(store.get(1), "Declined", "Out of stock")
    second = service.resend(first)

    sent_first, sent_second = webhook.requests
    assert sent_first.body == sent_second.body == first.event_xml.encode("utf-8")
    assert second.event_id == first.event_id and second.id == first.id
    assert sent_first.headers["x-webhook-timestamp"] == "2000"
    assert sent_second.headers["x-webhook-timestamp"] == "2001"
    assert sent_first.headers["x-webhook-signature"] != sent_second.headers["x-webhook-signature"]
    assert second.attempts == 2 and len(store.events_of(1)) == 1


def test_an_invalid_event_is_never_stored_or_sent(store, event_schema):
    store.add(_accepted("NOT-A-ULID"))
    sent = []

    class Spy:
        def send(self, body: bytes) -> SendResult:
            sent.append(body)
            return SendResult(delivered=True, http_status=200)

    with pytest.raises(EventInvalid):
        DecisionService(store, event_schema, Spy()).decide(store.get(2), "Approved", None)

    assert sent == [] and store.events_of(2) == []


def test_an_event_cannot_be_stored_for_a_message_that_does_not_exist(store, event_schema):
    built = build_event(event_schema, SAMPLE_ID, "Approved", None, utc_now())

    with pytest.raises(sqlite3.IntegrityError):
        store.add_event(
            NewDecisionEvent(99, built.event_id, "Approved", None, built.occurred_at, built.xml)
        )
