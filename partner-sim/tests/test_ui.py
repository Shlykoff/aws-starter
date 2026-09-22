"""The web pages: login, security headers, what is shown, and that message text is never markup."""

import base64
import hashlib
import re
import secrets

import pytest
from helpers import API_KEY, SAMPLE_ID, UI_AUTH, UI_PASSWORD, UI_USER, make_submission, ulid

from app.ui import LOCAL_TIME_SCRIPT

PAGES = ["/", "/messages/1"]


def _only_our_script(page: str) -> None:
    """The page carries our one fixed script (the local time) and no other: text from a message
    never becomes a <script> element."""
    assert page.count("<script") == 1
    assert _inline_scripts(page) == [LOCAL_TIME_SCRIPT]


# --- Login ------------------------------------------------------------------------------------


@pytest.mark.parametrize("path", PAGES + ["/messages/abc", "/messages/999999999999999999999"])
def test_the_pages_need_the_password(client, post, path):
    post(make_submission())  # there is something to see

    response = client.get(path)

    assert response.status_code == 401
    assert response.headers["www-authenticate"].startswith("Basic")
    assert "01M30JDSMHY8CRX59V35WV731S" not in response.text  # nothing of the inbox leaks


@pytest.mark.parametrize(
    "auth",
    [
        (UI_USER, "wrong"),
        ("wrong", UI_PASSWORD),
        (UI_USER, ""),
        ("", ""),
        (UI_USER, UI_PASSWORD[:-1]),  # a prefix of the password
        (UI_USER, UI_PASSWORD + "x"),
        (UI_USER.upper(), UI_PASSWORD),
        (API_KEY, API_KEY),  # the API key is not the UI password
    ],
    ids=["password", "user", "empty-password", "empty", "prefix", "suffix", "case", "api-key"],
)
def test_a_wrong_login_is_refused(client, auth):
    assert client.get("/", auth=auth).status_code == 401


@pytest.mark.parametrize(
    "authorization",
    [
        "Basic",
        "Basic !!!not-base64!!!",
        "Basic bm8tY29sb24=",  # base64 of "no-colon": no user/password separator
        "Basic w7xzZXI6cMOkc3N3b3Jk",  # base64 of non-ASCII text (utf-8)
        "Bearer some-token",
        "Digest username=x",
    ],
    ids=["no-credentials", "not-base64", "no-colon", "non-ascii", "bearer", "digest"],
)
def test_a_malformed_authorization_header_is_a_401_not_an_error(client, authorization):
    response = client.get("/", headers={"Authorization": authorization})

    assert response.status_code == 401


def test_the_api_key_does_not_open_the_pages(client):
    assert client.get("/", headers={"X-API-Key": API_KEY}).status_code == 401


def test_the_right_login_opens_the_pages(client, post):
    post(make_submission())

    assert client.get("/", auth=UI_AUTH).status_code == 200
    assert client.get("/messages/1", auth=UI_AUTH).status_code == 200


def test_the_login_is_compared_in_constant_time(client, monkeypatch):
    calls = []
    real = secrets.compare_digest

    def spy(a, b):
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr(secrets, "compare_digest", spy)

    client.get("/", auth=(UI_USER, "wrong"))

    # The user name is compared too, even though the password is wrong.
    assert (UI_USER.encode(), UI_USER.encode()) in calls
    assert (b"wrong", UI_PASSWORD.encode()) in calls


def test_docs_openapi_and_healthz_stay_open(client):
    assert client.get("/healthz").status_code == 200
    assert client.get("/docs").status_code == 200
    spec = client.get("/openapi.json")
    assert spec.status_code == 200
    assert "/v1/submissions" in spec.json()["paths"]
    assert "/messages/{message_id}" not in spec.json()["paths"]  # the pages are not advertised


# --- Headers ----------------------------------------------------------------------------------


@pytest.mark.parametrize("path", PAGES)
def test_the_pages_carry_the_security_headers(client, post, path):
    post(make_submission())

    response = client.get(path, auth=UI_AUTH)

    assert response.headers["content-type"] == "text/html; charset=utf-8"
    policy = response.headers["content-security-policy"]
    assert policy.startswith("default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-")
    assert policy.endswith("'; form-action 'self'; frame-ancestors 'none'")
    assert response.headers["x-content-type-options"] == "nosniff"
    # same-origin, not no-referrer: see SECURITY_HEADERS in ui.py (no-referrer would make a
    # browser send "Origin: null" from our own form).
    assert response.headers["referrer-policy"] == "same-origin"
    assert response.headers["cache-control"] == "no-store"


def test_a_missing_message_is_a_404_page_with_the_headers_too(client):
    response = client.get("/messages/12345", auth=UI_AUTH)

    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/messages/999999999999999999999", auth=UI_AUTH).status_code == 404


# --- The inbox --------------------------------------------------------------------------------


def test_the_inbox_says_how_to_send_a_message_without_revealing_the_key(client):
    page = client.get("/", auth=UI_AUTH).text

    assert "http://testserver/v1/submissions" in page
    assert "curl" in page and "X-API-Key: YOUR_API_KEY" in page
    assert API_KEY not in page
    assert UI_PASSWORD not in page


def test_the_inbox_uses_the_forwarded_scheme_behind_a_tunnel(client):
    page = client.get("/", auth=UI_AUTH, headers={"X-Forwarded-Proto": "https"}).text

    assert "https://testserver/v1/submissions" in page


def test_the_inbox_refreshes_itself_every_5_seconds(client):
    assert '<meta http-equiv="refresh" content="5">' in client.get("/", auth=UI_AUTH).text


def test_the_message_page_does_not_refresh(client, post):
    post(make_submission())

    assert "http-equiv" not in client.get("/messages/1", auth=UI_AUTH).text


def test_an_empty_inbox_says_so(client):
    assert "Nothing has arrived yet" in client.get("/", auth=UI_AUTH).text


def test_the_inbox_shows_outcomes_status_and_the_newest_first(client, post):
    post(make_submission(message_id=ulid(1), subject="first accepted"))
    post(make_submission(message_id=ulid(2), subject="second [reject]"))
    post(make_submission(message_id=ulid(3), subject=""))  # schema-invalid
    post(b"not xml")

    page = client.get("/", auth=UI_AUTH).text

    assert page.index("/messages/4") < page.index("/messages/3") < page.index("/messages/1")
    assert "Accepted" in page
    assert "Rejected &middot; RECIPIENT_REJECTED" in page
    assert "Rejected &middot; SCHEMA_INVALID" in page
    assert "Rejected &middot; MALFORMED_XML" in page
    assert "first accepted" in page and "second [reject]" in page


def test_the_inbox_shows_sender_and_drops_messageid_recipient_and_http(client, post):
    post(make_submission(sender="shlykoff@gmail.com", recipient="Partner OK"))

    page = client.get("/", auth=UI_AUTH).text

    assert "<th>Sender</th>" in page
    assert "shlykoff@gmail.com" in page
    for gone in ("<th>MessageId</th>", "<th>Recipient</th>", "<th>HTTP</th>"):
        assert gone not in page
    assert SAMPLE_ID not in page  # the MessageId text itself is gone too, not just its column
    assert "Partner OK" not in page  # the fixed Recipient is no longer informative, so not shown


def test_the_message_page_shows_sender_and_drops_messageid_recipient_and_http(client, post):
    post(make_submission(sender="shlykoff@gmail.com", recipient="Partner OK"))

    page = client.get("/messages/1", auth=UI_AUTH).text

    assert "<dt>Sender</dt>" in page
    assert "shlykoff@gmail.com" in page
    # The three summary fields are gone; the MessageId/Recipient text can still legitimately
    # appear further down, inside the raw "Received XML"/"Reply sent" <pre> dumps.
    for gone in ("<dt>MessageId</dt>", "<dt>Recipient</dt>", "HTTP status sent"):
        assert gone not in page


def test_the_inbox_shows_only_the_newest_100(client, post):
    for n in range(103):
        post(make_submission(message_id=ulid(n)))

    page = client.get("/", auth=UI_AUTH).text

    links = re.findall(r'href="/messages/(\d+)"', page)
    assert len(links) == 100
    assert links[0] == "103" and links[-1] == "4"


def test_long_values_are_shortened_in_the_inbox_but_complete_on_the_message_page(client, post):
    subject = "S" * 150
    post(make_submission(subject=subject))

    inbox = client.get("/", auth=UI_AUTH).text
    detail = client.get("/messages/1", auth=UI_AUTH).text

    assert subject not in inbox and "S" * 40 in inbox
    assert subject in detail


# --- The message page -------------------------------------------------------------------------


def test_the_message_page_shows_findings_both_documents_and_times(client, post):
    post(make_submission(recipient="Acme #1"))

    page = client.get("/messages/1", auth=UI_AUTH).text

    assert "Rejected &middot; SCHEMA_INVALID" in page
    assert '<td class="nowrap">7</td>' in page  # the line of the finding
    assert "not accepted by the pattern" in page
    assert "&lt;Header&gt;\n    &lt;MessageId&gt;" in page  # re-indented, and escaped
    assert "&lt;Code&gt;SCHEMA_INVALID&lt;/Code&gt;" in page  # the reply that was sent
    assert re.search(r"20\d\d-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} UTC", page)


def test_an_accepted_message_has_no_findings(client, post):
    post(make_submission())

    assert "None: the message passed every check" in client.get("/messages/1", auth=UI_AUTH).text


def test_the_page_of_a_malformed_message_shows_the_raw_text(client, post):
    post(b"<a>\n<b>")

    page = client.get("/messages/1", auth=UI_AUTH).text

    assert "&lt;a&gt;\n&lt;b&gt;" in page  # cannot be re-indented, so shown as it came
    assert "MALFORMED_XML" in page
    assert "(not readable)" in page


# --- Text from a message is text, never markup ------------------------------------------------

SCRIPT = "<script>alert('xss')</script>"
IMG = "<img src=x onerror=alert(1)>"


def test_markup_inside_a_message_is_shown_as_text_never_rendered(client, post):
    post(make_submission(subject=IMG, text=SCRIPT, recipient="Partner OK"))

    inbox = client.get("/", auth=UI_AUTH).text
    detail = client.get("/messages/1", auth=UI_AUTH).text

    for page in (inbox, detail):
        _only_our_script(page)
        assert "<img" not in page
    assert "&lt;img src=x onerror=alert(1)&gt;" in inbox  # the subject, escaped once
    assert "&lt;img src=x onerror=alert(1)&gt;" in detail
    # In the XML shown in <pre> the text is already escaped once by XML itself (&lt;script&gt;),
    # and Jinja escapes the ampersand again, so the reader sees the XML exactly as sent.
    assert "&amp;lt;script&amp;gt;alert(" in detail


def test_raw_markup_in_a_broken_message_is_shown_as_text_never_rendered(client, post):
    post(b"<Submission><script>alert(1)</script><img src=x onerror=alert(1)>")

    detail = client.get("/messages/1", auth=UI_AUTH).text

    _only_our_script(detail)
    assert "<img" not in detail
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in detail


def test_markup_in_the_findings_and_the_reply_is_escaped(client, post):
    # The validator quotes the offending value, which is attacker text.
    post(make_submission(recipient="<b>bold</b>"))

    page = client.get("/messages/1", auth=UI_AUTH).text

    assert "<b>bold</b>" not in page
    assert "&lt;b&gt;bold&lt;/b&gt;" in page


def test_a_hostile_host_header_cannot_inject_markup_into_the_example(client):
    page = client.get("/", auth=UI_AUTH, headers={"Host": "evil.example<script>x</script>"}).text

    assert "<script>x</script>" not in page


@pytest.mark.parametrize("path", PAGES)
def test_the_clear_button_is_on_every_authenticated_page(client, post, path):
    post(make_submission())

    page = client.get(path, auth=UI_AUTH).text

    assert '<form class="inline" method="post" action="/admin/reset">' in page
    assert ">Clear<" in page


def test_the_clear_button_is_not_shown_without_the_login(client, post):
    post(make_submission())

    response = client.get("/")

    assert response.status_code == 401
    assert "/admin/reset" not in response.text


# --- Switching the interface off --------------------------------------------------------------


def test_with_the_interface_off_only_the_api_remains(make_client, settings):
    client = make_client(ui_enabled=False, ui_user="", ui_password="")

    assert client.get("/", auth=UI_AUTH).status_code == 404
    assert client.get("/messages/1", auth=UI_AUTH).status_code == 404
    assert client.get("/healthz").status_code == 200
    response = client.post(
        "/v1/submissions",
        content=make_submission(),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/xml"},
    )
    assert response.status_code == 200


# --- Times: the viewer's local time, in the sender's format --------------------------------------


def _inline_scripts(html: str) -> list[str]:
    return re.findall(r"<script>(.*?)</script>", html, flags=re.DOTALL)


@pytest.mark.parametrize("path", PAGES)
def test_the_one_inline_script_is_the_one_the_policy_names(client, post, path):
    """The CSP allows a script by its hash. If the script in the page and the hash in the header
    ever differ (an edit of one but not the other), the browser refuses it and every time on the
    page silently goes back to UTC: this test is what notices."""
    post(make_submission())
    response = client.get(path, auth=UI_AUTH)

    scripts = _inline_scripts(response.text)

    assert len(scripts) == 1
    digest = base64.b64encode(hashlib.sha256(scripts[0].encode("utf-8")).digest()).decode()
    assert f"script-src 'sha256-{digest}'" in response.headers["content-security-policy"]


def test_a_time_is_a_time_element_with_the_utc_text_inside(client, post):
    post(make_submission())

    inbox = client.get("/", auth=UI_AUTH).text
    message = client.get("/messages/1", auth=UI_AUTH).text

    for page in (inbox, message):
        # The datetime attribute is the moment itself (ISO, UTC); the text is what a browser
        # without scripts shows, labelled, so that it can never be mistaken for local time.
        match = re.search(
            r'<time datetime="(\d{4}-\d\d-\d\dT[\d:.]+Z)">(\d{4}-\d\d-\d\d [\d:.]+) UTC</time>',
            page,
        )
        assert match is not None
        assert match.group(1).replace("T", " ").removesuffix("Z") == match.group(2)


def test_the_script_formats_a_time_like_the_senders_web_app():
    """frontend/src/shared/lib/formatDate.ts uses these options; the two must stay the same, or
    the same moment reads differently in the two applications."""
    for option in (
        'year: "numeric"',
        'month: "short"',
        'day: "numeric"',
        'hour: "numeric"',
        'minute: "2-digit"',
        'second: "2-digit"',
        'timeZoneName: "short"',
    ):
        assert option in LOCAL_TIME_SCRIPT
