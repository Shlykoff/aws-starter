"""The web interface: the inbox (GET /) and one message (GET /messages/{id}).

Server-rendered HTML with Jinja2, no JavaScript. Both pages sit behind HTTP Basic auth, because
the simulator may be reachable through a public tunnel and the inbox holds other people's
messages. Text from a submission is untrusted: it only ever reaches the page through Jinja2 with
autoescape on, so markup inside a message is shown as text and is never interpreted.
"""

from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from jinja2 import Environment, FileSystemLoader, StrictUndefined

from app.config import Settings
from app.security import same_secret
from app.storage import MessageStore
from app.xml_input import pretty_print

INBOX_SIZE = 100

# Sent with every HTML page. The CSP forbids everything except the page's own inline <style>:
# no scripts, no images, no forms, no framing.
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",  # the pages show private data: keep them out of caches
}

_templates = Environment(
    loader=FileSystemLoader(Path(__file__).parent / "templates"),
    autoescape=True,  # the one line that keeps message text from becoming markup
    undefined=StrictUndefined,  # a typo in a template is an error, not an empty string
)
# 2026-09-21T10:11:12.123Z -> 2026-09-21 10:11:12.123
_templates.filters["utc_text"] = lambda stamp: stamp.replace("T", " ").removesuffix("Z")


def build_ui_router(store: MessageStore, settings: Settings) -> APIRouter:
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
        return _page(
            "inbox.html",
            rows=store.list_recent(INBOX_SIZE),
            endpoint=f"{_base_url(request)}/v1/submissions",
        )

    @router.get("/messages/{message_id}", response_class=HTMLResponse)
    def message(message_id: int) -> HTMLResponse:
        found = store.get(message_id)
        if found is None:
            return _page("not_found.html", status_code=404)
        return _page(
            "message.html",
            m=found,
            request_xml=pretty_print(found.request_xml),
            reply_xml=pretty_print(found.reply_xml),
        )

    return router


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
