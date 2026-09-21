"""Nothing secret or user-supplied is written to the log."""

import logging

from helpers import API_KEY, UI_AUTH, UI_PASSWORD, make_submission

MARKER = "SUBJECT-MARKER-4711"
TEXT_MARKER = "TEXT-MARKER-0815"


def test_bodies_keys_and_passwords_never_reach_the_log(client, post, caplog):
    caplog.set_level(logging.DEBUG)

    post(make_submission(subject=MARKER, text=TEXT_MARKER))  # accepted
    post(make_submission(subject=MARKER, text=TEXT_MARKER))  # a duplicate
    post(make_submission(subject=f"{MARKER} [reject]", message_id="MSG-ID-MARKER-1"))  # rejected
    post(make_submission(subject=f"{MARKER} [fail]", message_id="MSG-ID-MARKER-2"))  # 503
    post(make_submission(subject=""), **{"X-API-Key": "wrong-key-marker"})  # 401
    post(f"<broken>{MARKER}".encode())  # malformed
    client.get("/", auth=UI_AUTH)
    client.get("/", auth=("inbox-user", "wrong-password-marker"))

    log = caplog.text
    assert "submission answered" in log  # the log is not simply empty
    for secret in (
        MARKER, TEXT_MARKER, "MSG-ID-MARKER", "01M30JDSMHY8CRX59V35WV731S",
        API_KEY, "wrong-key-marker", UI_PASSWORD, "wrong-password-marker", "<Submission",
    ):  # fmt: skip
        assert secret not in log
