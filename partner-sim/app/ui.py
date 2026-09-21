"""The web interface: the inbox (GET /), one message (GET /messages/{id}), and the client's
actions on a message (POST .../decision, POST .../decision/{event}/resend).

Server-rendered HTML with Jinja2, no JavaScript. Every route sits behind HTTP Basic auth, because
the simulator may be reachable through a public tunnel and the inbox holds other people's
messages. Text from a submission or a reason is untrusted: it only ever reaches the page through
Jinja2 with autoescape on, so markup in it is shown as text and is never interpreted.

The two POST routes change state, and a browser attaches the Basic-auth login to ANY request to
this address, also to one made by a form on another web site. So they refuse cross-site requests
(_is_same_origin) before they do anything else.
"""

import base64
import hashlib
import logging
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from jinja2 import Environment, FileSystemLoader, StrictUndefined
from markupsafe import Markup
from starlette.concurrency import run_in_threadpool

from app.config import Settings
from app.decisions import DecisionService
from app.events import DECISIONS, EventInvalid, ReasonRejected, clean_reason
from app.models import MessageDetail, StoredEvent
from app.security import same_secret
from app.storage import MessageStore
from app.xml_input import pretty_print

log = logging.getLogger("partner_sim")

INBOX_SIZE = 100

# A form with a reason of 500 characters is at most about 6 KB once percent-encoded.
FORM_MAX_BYTES = 16 * 1024

# Times are stored and sent in UTC, and a page written in UTC only would disagree with the
# sender's web app, which shows the time in the viewer's own time zone: the same moment would
# read four hours apart for somebody in UTC+4. So every time is a <time datetime="..."> element
# with the UTC text inside (what a browser without scripts shows, labelled UTC), and this one
# small script, fixed and written by us, replaces the text with the viewer's local time and
# zone in the SAME format as the sender's web app (frontend/src/shared/lib/formatDate.ts).
LOCAL_TIME_SCRIPT = (
    'document.querySelectorAll("time[datetime]").forEach(function (el) {'
    'var d = new Date(el.getAttribute("datetime"));'
    "if (!isNaN(d.getTime())) {"
    'el.textContent = d.toLocaleString(undefined, {year: "numeric", month: "short", '
    'day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", '
    'timeZoneName: "short"});'
    "}});"
)
# The page may run this script and no other: the policy names it by its hash, so a script that
# somebody managed to get into a page (there is none: autoescape is on) would still not run.
_SCRIPT_HASH = base64.b64encode(hashlib.sha256(LOCAL_TIME_SCRIPT.encode("utf-8")).digest()).decode()

# Sent with every HTML page. The CSP forbids everything except the page's own inline <style>,
# the one script above and forms that post back to this same address: no images, no framing.
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        f"default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-{_SCRIPT_HASH}'; "
        "form-action 'self'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    # same-origin, not no-referrer: with no-referrer a browser sends "Origin: null" on a form
    # POST, and then the cross-site check (_is_same_origin) could not tell our own form from a
    # foreign one. same-origin still tells other web sites nothing.
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store",  # the pages show private data: keep them out of caches
}

_templates = Environment(
    loader=FileSystemLoader(Path(__file__).parent / "templates"),
    autoescape=True,  # the one line that keeps message text from becoming markup
    undefined=StrictUndefined,  # a typo in a template is an error, not an empty string
)
_templates.globals["local_time_script"] = LOCAL_TIME_SCRIPT


def _time_tag(stamp: str) -> Markup:
    """2026-09-21T10:11:12.123Z -> <time datetime="...">2026-09-21 10:11:12.123 UTC</time>.

    The text is what shows without the script. `stamp` comes from our own clock, but it is
    escaped like everything else: Markup() is applied only to the finished tag."""
    text = str(stamp).replace("T", " ").removesuffix("Z")
    return Markup('<time datetime="{}">{} UTC</time>').format(stamp, text)


_templates.filters["time_tag"] = _time_tag


def build_ui_router(
    store: MessageStore, settings: Settings, decisions: DecisionService | None
) -> APIRouter:
    """`decisions` is None when the webhook is not configured: the pages then offer no action."""
    basic = HTTPBasic(auto_error=False)  # we send the 401 ourselves, with the right headers

    def require_login(credentials: Annotated[HTTPBasicCredentials | None, Depends(basic)]) -> None:
        # Both comparisons always run (no early exit on a wrong user name), each in constant time.
        user_ok = credentials is not None and same_secret(credentials.username, settings.ui_user)
        password_ok = credentials is not None and same_secret(
            credentials.password, settings.ui_password
        )
        if not (user_ok and password_ok):
            raise HTTPException(
                status_code=401,
                detail="Login required",
                headers={"WWW-Authenticate": 'Basic realm="partner-sim"'},
            )

    # The login is set on the router, so every page added here is protected without asking.
    router = APIRouter(dependencies=[Depends(require_login)], include_in_schema=False)

    @router.get("/", response_class=HTMLResponse)
    def inbox(request: Request) -> HTMLResponse:
        rows = store.list_recent(INBOX_SIZE)
        # The newest rows have the highest ids, so the last one is the lowest id on the page.
        overview = store.decision_overview(rows[-1].id) if rows else {}
        return _page(
            "inbox.html",
            rows=rows,
            overview=overview,
            endpoint=f"{_base_url(request)}/v1/submissions",
        )

    def message_page(
        found: MessageDetail,
        *,
        status_code: int = 200,
        error: str | None = None,
        reason_text: str = "",
        sent_event: str | None = None,
    ) -> HTMLResponse:
        """The page of one message. `error` is shown above the form; `reason_text` refills it;
        `sent_event` is the id of the event whose outcome the page reports (after a POST)."""
        events = store.events_of(found.id)
        result = None
        for event in events:
            if event.event_id == sent_event:
                result = _outcome_line(event)
        return _page(
            "message.html",
            status_code=status_code,
            m=found,
            request_xml=pretty_print(found.request_xml),
            reply_xml=pretty_print(found.reply_xml),
            events=events,
            webhook_configured=decisions is not None,
            error=error,
            reason_text=reason_text,
            result=result,
        )

    @router.get("/messages/{message_id}", response_class=HTMLResponse)
    def message(message_id: int, event: str | None = None) -> HTMLResponse:
        found = store.get(message_id)
        if found is None:
            return _page("not_found.html", status_code=404)
        return message_page(found, sent_event=event)

    # --- The client's actions (state-changing: POST, and refused when cross-site) -------------

    def decide(message_id: int, form: dict[str, str]) -> Response:
        found = store.get(message_id)
        if found is None:
            return _page("not_found.html", status_code=404)
        if decisions is None:
            return message_page(found, status_code=409, error="The webhook is not configured.")
        if found.outcome != "accepted":
            return message_page(
                found, status_code=409, error="Only an accepted message can get a client action."
            )
        decision = form.get("decision")
        if decision not in DECISIONS:
            return message_page(found, status_code=400, error="Choose Approve or Decline.")
        raw_reason = form.get("reason", "")
        try:
            reason = clean_reason(raw_reason)
        except ReasonRejected as exc:
            return message_page(found, status_code=422, error=str(exc), reason_text=raw_reason)
        try:
            event = decisions.decide(found, decision, reason)
        except EventInvalid:
            return message_page(
                found,
                status_code=500,
                error="The event could not be built (a bug: see the log). Nothing was sent.",
            )
        return _see_other(found.id, event)

    def resend(message_id: int, event_id: str) -> Response:
        found = store.get(message_id)
        if found is None:
            return _page("not_found.html", status_code=404)
        if decisions is None:
            return message_page(found, status_code=409, error="The webhook is not configured.")
        # The event must belong to THIS message, so the address cannot name another one's.
        event = store.get_event(found.id, event_id)
        if event is None:
            return _page("not_found.html", status_code=404)
        return _see_other(found.id, decisions.resend(event))

    @router.post("/messages/{message_id}/decision")
    async def post_decision(message_id: int, request: Request) -> Response:
        if not _is_same_origin(request):
            return _refuse_cross_site()
        form = await _read_form(request)
        if isinstance(form, Response):
            return form
        # Sending is blocking work (up to the webhook's timeout): a worker thread keeps the
        # event loop free.
        return await run_in_threadpool(decide, message_id, form)

    @router.post("/messages/{message_id}/decision/{event_id}/resend")
    async def post_resend(message_id: int, event_id: str, request: Request) -> Response:
        if not _is_same_origin(request):
            return _refuse_cross_site()
        return await run_in_threadpool(resend, message_id, event_id)

    return router


def _is_same_origin(request: Request) -> bool:
    """True only for a request that came from a page of this very address.

    Browsers say where a request comes from, and a web page cannot forge these headers:
      * Sec-Fetch-Site, when present, must be same-origin (a page of this address) or none
        (the person typed it or used a bookmark). cross-site and same-site are refused.
      * Origin, when present, must name this host. "null" (sent from some sandboxed pages)
        names nothing and is refused.
      * Without Origin, the Referer must name this host.
      * With neither, the request is refused: we cannot tell where it came from.
    Only host and port are compared, not the scheme, because behind a tunnel this application
    sees http while the browser used https. "This host" is the Host header of the request.
    """
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site is not None and fetch_site not in ("same-origin", "none"):
        return False
    host = request.headers.get("host", "").lower()
    if not host:
        return False
    origin = request.headers.get("origin")
    if origin is not None:
        return urlsplit(origin).netloc.lower() == host
    referer = request.headers.get("referer")
    if referer is not None:
        return urlsplit(referer).netloc.lower() == host
    return False


def _refuse_cross_site() -> PlainTextResponse:
    log.warning("a cross-site or unverifiable POST was refused")
    return PlainTextResponse(
        "Refused: this request did not come from a page of this address.",
        status_code=403,
        headers=SECURITY_HEADERS,
    )


async def _read_form(request: Request) -> dict[str, str] | PlainTextResponse:
    """The fields of an application/x-www-form-urlencoded body (what a browser form sends).

    Read here with the standard library: Starlette's own form parser needs the extra package
    python-multipart, which one small form does not justify. Returns a plain-text refusal
    (413, 415 or 400) instead of the fields when the request is not acceptable.
    """
    media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if media_type != "application/x-www-form-urlencoded":
        return PlainTextResponse("Send a form (application/x-www-form-urlencoded).", 415)
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > FORM_MAX_BYTES:  # stop reading: the rest is never buffered
            return PlainTextResponse("The form is too large.", 413)
    try:
        fields = parse_qs(
            body.decode("utf-8", errors="replace"), keep_blank_values=True, max_num_fields=10
        )
    except ValueError:  # too many fields
        return PlainTextResponse("The form is not acceptable.", 400)
    if any(len(values) != 1 for values in fields.values()):
        return PlainTextResponse("A field may appear only once.", 400)
    return {name: values[0] for name, values in fields.items()}


def _see_other(message_row_id: int, event: StoredEvent) -> RedirectResponse:
    """303 back to the message page. The event id in the address is only a pointer: the page
    looks it up and writes the outcome line itself, so no free text travels in the address."""
    return RedirectResponse(
        f"/messages/{message_row_id}?event={event.event_id}",
        status_code=303,
        headers=SECURITY_HEADERS,
    )


def _outcome_line(event: StoredEvent) -> tuple[bool, str]:
    """(worked, the sentence) for the result of the latest attempt to send an event."""
    if event.state == "delivered":
        return True, f"Sent: the sender answered {event.last_status}"
    if event.last_status is not None:
        return False, f"Not delivered: HTTP {event.last_status}"
    if event.state == "failed":
        return False, "Not delivered: no answer"
    return False, "Not sent yet"


def _page(template: str, status_code: int = 200, **context: Any) -> HTMLResponse:
    html = _templates.get_template(template).render(**context)
    return HTMLResponse(html, status_code=status_code, headers=SECURITY_HEADERS)


def _base_url(request: Request) -> str:
    """scheme://host as the browser sees it, so the example works behind a tunnel too."""
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    if scheme not in ("http", "https"):
        scheme = request.url.scheme
    host = request.headers.get("host", "localhost")
    return f"{scheme}://{host}"  # shown as escaped text only; never used to build a link
