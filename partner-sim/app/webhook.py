"""Calling the sender's webhook (contracts/webhook-api.md): the signature and one POST.

The token is the key of an HMAC. It never travels, and it is never logged or stored: this module
takes it in the constructor, uses it inside sign(), and keeps it in no other place.
"""

import hashlib
import hmac
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

import httpx

log = logging.getLogger("partner_sim")

TIMEOUT_SECONDS = 8.0
USER_AGENT = "partner-sim/1"


def sign(token: str, timestamp: str, body: bytes) -> str:
    """The value of X-Webhook-Signature: "v1=" and the hex of HMAC-SHA256.

    The key is the token as UTF-8 bytes. The signed bytes are the timestamp text, one dot, and
    the body exactly as it is sent. Signing the timestamp too is what stops a captured request
    from being replayed later: the sender refuses timestamps that are too old.
    """
    message = timestamp.encode("ascii") + b"." + body
    digest = hmac.new(token.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return f"v1={digest}"


@dataclass(frozen=True)
class SendResult:
    delivered: bool  # True for any 2xx answer
    http_status: int | None  # None when nobody answered (refused, timed out, ...)


class WebhookClient:
    def __init__(
        self,
        url: str,
        token: str,
        timeout: float = TIMEOUT_SECONDS,
        clock: Callable[[], float] = time.time,  # a parameter so that a test can fix the time
    ) -> None:
        self._url = url
        self._token = token
        self._timeout = timeout
        self._clock = clock

    def send(self, body: bytes) -> SendResult:
        """POST `body` once, with a fresh timestamp and signature. Never raises for a network
        problem: "nobody answered" is a normal result here. There is no retry."""
        timestamp = str(int(self._clock()))  # whole seconds, digits only
        headers = {
            "Content-Type": "application/xml",
            "X-Webhook-Timestamp": timestamp,
            "X-Webhook-Signature": sign(self._token, timestamp, body),
            "User-Agent": USER_AGENT,
        }
        try:
            # A client per call: nothing is shared between threads. follow_redirects=False: an
            # answer such as 302 is a failure, and the request (with its signature) is never
            # sent on to another address. trust_env=False: proxy settings and ~/.netrc of the
            # environment are not consulted, so the request goes exactly where WEBHOOK_URL says.
            with httpx.Client(
                timeout=self._timeout, follow_redirects=False, trust_env=False
            ) as client:
                # stream(): only the status line and headers are read. The contract says the
                # answer has no body, so whatever comes after them is not our business.
                with client.stream("POST", self._url, content=body, headers=headers) as response:
                    status = response.status_code
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            # Only the kind of error: the text of an exception can hold the address.
            log.warning("the webhook did not answer (%s)", type(exc).__name__)
            return SendResult(delivered=False, http_status=None)
        return SendResult(delivered=200 <= status < 300, http_status=status)
