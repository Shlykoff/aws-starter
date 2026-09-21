"""The partner API: POST /v1/submissions and GET /healthz (contracts/partner-api.md).

This layer only speaks HTTP: it does steps 1-3 of the contract (key, content type, size) and
turns the service's Answer into a response. Everything after that is in service.py.
"""

from typing import Annotated

from fastapi import APIRouter, Header, Request, Response
from starlette.concurrency import run_in_threadpool

from app.config import Settings
from app.security import same_secret
from app.service import Answer, SubmissionService

XML_CONTENT_TYPE = "application/xml; charset=utf-8"

# Only for the /docs page: it tells Swagger UI that the body is a text box with XML in it.
_BODY_FOR_DOCS = {
    "requestBody": {
        "required": True,
        "content": {"application/xml": {"schema": {"type": "string"}}},
    }
}

_RESPONSES_FOR_DOCS = {
    200: {
        "description": "Accepted. Body: a Reply with Status Accepted.",
        "content": {XML_CONTENT_TYPE: {}},
    },
    400: {"description": "Not well-formed XML, or it has a DOCTYPE. Reply: MALFORMED_XML."},
    401: {"description": "Missing or wrong X-API-Key. No body."},
    413: {"description": "The body is larger than the limit. No body."},
    415: {"description": "Content-Type is not application/xml. No body."},
    422: {
        "description": "Violates submission.xsd (SCHEMA_INVALID), or refused by the "
        "recipient's own rules (RECIPIENT_REJECTED)."
    },
    503: {
        "description": "Temporarily unavailable (Subject contains [fail]). Retry-After: 1, no body."
    },
}


def build_api_router(service: SubmissionService, settings: Settings) -> APIRouter:
    router = APIRouter()

    @router.post(
        "/v1/submissions",
        summary="Deliver one submission",
        openapi_extra=_BODY_FOR_DOCS,
        responses=_RESPONSES_FOR_DOCS,
        response_class=Response,
    )
    async def post_submission(
        request: Request,
        x_api_key: Annotated[
            str | None, Header(alias="X-API-Key", description="The partner API key.")
        ] = None,
        # Declared only so that /docs shows it. The recipient never reads it: it deduplicates by
        # the MessageId inside the document (contract).
        idempotency_key: Annotated[
            str | None, Header(alias="Idempotency-Key", description="Informational, ignored.")
        ] = None,
    ) -> Response:
        # Step 1: the key. Missing and wrong look the same to the caller: 401, no body.
        if x_api_key is None or not same_secret(x_api_key, settings.api_key):
            return Response(status_code=401)

        # Step 2: the content type. Only the media type counts; a charset parameter is fine.
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != "application/xml":
            return Response(status_code=415)

        # Step 3: the size, checked twice. First the announced length: cheap, and refuses
        # before a single body byte is read. But the header can be absent (chunked upload) or
        # can lie, so then the bytes actually arriving are counted too.
        announced = _announced_length(request)
        if announced is not None and announced > settings.max_body_bytes:
            return Response(status_code=413)
        body = await _read_at_most(request, settings.max_body_bytes)
        if body is None:
            return Response(status_code=413)

        # The rest is blocking work (XML, SQLite). A worker thread keeps the event loop free.
        answer = await run_in_threadpool(service.handle, body)
        return _to_response(answer)

    @router.get("/healthz", summary="Liveness check (no key needed)")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return router


def _announced_length(request: Request) -> int | None:
    try:
        return int(request.headers["content-length"])
    except (KeyError, ValueError):
        return None


async def _read_at_most(request: Request, limit: int) -> bytes | None:
    """The whole body, or None as soon as it turns out to be longer than `limit` bytes."""
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > limit:
            return None  # stop reading; the rest of a huge upload is never buffered
        chunks.append(chunk)
    return b"".join(chunks)


def _to_response(answer: Answer) -> Response:
    headers = {}
    if answer.retry_after_seconds is not None:
        headers["Retry-After"] = str(answer.retry_after_seconds)
    if answer.reply_xml is None:
        return Response(status_code=answer.status_code, headers=headers)
    return Response(
        content=answer.reply_xml.encode("utf-8"),
        status_code=answer.status_code,
        media_type=XML_CONTENT_TYPE,
        headers=headers,
    )
