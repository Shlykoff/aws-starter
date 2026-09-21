"""Configuration from environment variables, validated at start-up."""

from pathlib import Path

import pytest
from helpers import API_KEY, SCHEMA_DIR

from app.config import ConfigError, load_settings
from app.main import create_app, create_app_from_env
from app.validation import SchemaLoadError

MINIMAL = {"PARTNER_API_KEY": "k", "UI_USER": "u", "UI_PASSWORD": "p"}


def test_defaults():
    settings = load_settings(MINIMAL)

    assert settings.api_key == "k"
    assert settings.ui_enabled is True
    assert settings.db_path == Path("/data/partner.db")
    assert settings.schema_dir == Path("/app/schemas")
    assert settings.max_body_bytes == 65536
    assert settings.log_level == "INFO"
    assert settings.webhook_url is None and settings.webhook_token is None


def test_every_value_can_be_set():
    settings = load_settings(
        {
            **MINIMAL,
            "DB_PATH": "/tmp/x.db",
            "SCHEMA_DIR": "/tmp/xsd",
            "MAX_BODY_BYTES": "1000",
            "LOG_LEVEL": "debug",
        }
    )

    assert settings.db_path == Path("/tmp/x.db")
    assert settings.schema_dir == Path("/tmp/xsd")
    assert settings.max_body_bytes == 1000
    assert settings.log_level == "DEBUG"


@pytest.mark.parametrize("key", ["", "   "])
def test_the_api_key_is_required(key):
    with pytest.raises(ConfigError, match="PARTNER_API_KEY"):
        load_settings({**MINIMAL, "PARTNER_API_KEY": key})


def test_the_api_key_may_not_be_missing_altogether():
    with pytest.raises(ConfigError, match="PARTNER_API_KEY"):
        load_settings({"UI_USER": "u", "UI_PASSWORD": "p"})


@pytest.mark.parametrize("missing", ["UI_USER", "UI_PASSWORD"])
def test_the_login_is_required_while_the_interface_is_on(missing):
    env = {k: v for k, v in MINIMAL.items() if k != missing}

    with pytest.raises(ConfigError, match=missing):
        load_settings(env)


def test_the_login_is_not_needed_when_the_interface_is_off():
    settings = load_settings({"PARTNER_API_KEY": "k", "UI_ENABLED": "false"})

    assert settings.ui_enabled is False


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("UI_ENABLED", "maybe"),
        ("MAX_BODY_BYTES", "abc"),
        ("MAX_BODY_BYTES", "0"),
        ("MAX_BODY_BYTES", "-5"),
        ("MAX_BODY_BYTES", "1.5"),
        ("LOG_LEVEL", "LOUD"),
    ],
)
def test_bad_values_are_refused(name, value):
    with pytest.raises(ConfigError, match=name):
        load_settings({**MINIMAL, name: value})


def test_all_the_problems_are_reported_together():
    with pytest.raises(ConfigError) as caught:
        load_settings({"MAX_BODY_BYTES": "x"})

    message = str(caught.value)
    for name in ("PARTNER_API_KEY", "UI_USER", "UI_PASSWORD", "MAX_BODY_BYTES"):
        assert name in message


def test_the_secrets_are_not_in_the_printed_form_of_the_settings():
    env = {"PARTNER_API_KEY": "the-key-value", "UI_USER": "u", "UI_PASSWORD": "the-password"}

    text = repr(load_settings(env))

    assert "the-key-value" not in text
    assert "the-password" not in text


# --- The client's side: WEBHOOK_URL and WEBHOOK_TOKEN ------------------------------------------

WEBHOOK = {"WEBHOOK_URL": "https://abc123.execute-api.eu-north-1.amazonaws.com/webhooks/partner",
           "WEBHOOK_TOKEN": "0123456789abcdef"}  # fmt: skip


def test_the_webhook_can_be_configured():
    settings = load_settings({**MINIMAL, **WEBHOOK})

    assert settings.webhook_url == WEBHOOK["WEBHOOK_URL"]
    assert settings.webhook_token == WEBHOOK["WEBHOOK_TOKEN"]


@pytest.mark.parametrize("value", ["", "   "])
def test_empty_webhook_values_mean_not_configured(value):
    # docker-compose.yml passes ${WEBHOOK_URL:-} and ${WEBHOOK_TOKEN:-}: empty when not set.
    settings = load_settings({**MINIMAL, "WEBHOOK_URL": value, "WEBHOOK_TOKEN": value})

    assert settings.webhook_url is None and settings.webhook_token is None


@pytest.mark.parametrize(
    ("given", "named"),
    [("WEBHOOK_URL", "only WEBHOOK_URL"), ("WEBHOOK_TOKEN", "only WEBHOOK_TOKEN")],
)
def test_the_webhook_url_and_token_come_together_or_not_at_all(given, named):
    with pytest.raises(ConfigError, match="must be set together") as caught:
        load_settings({**MINIMAL, given: WEBHOOK[given]})

    assert named in str(caught.value)


def test_the_token_is_at_least_16_characters():
    load_settings({**MINIMAL, **WEBHOOK, "WEBHOOK_TOKEN": "x" * 16})

    with pytest.raises(ConfigError, match="WEBHOOK_TOKEN must be at least 16 characters"):
        load_settings({**MINIMAL, **WEBHOOK, "WEBHOOK_TOKEN": "x" * 15})


@pytest.mark.parametrize("token", [" " + "x" * 20, "x" * 20 + "\n"])
def test_a_token_with_white_space_at_the_edge_is_refused_not_trimmed(token):
    with pytest.raises(ConfigError, match="must not start or end with a space"):
        load_settings({**MINIMAL, **WEBHOOK, "WEBHOOK_TOKEN": token})


def test_the_token_is_neither_in_the_printed_settings_nor_in_an_error_message():
    settings = load_settings({**MINIMAL, **WEBHOOK})
    with pytest.raises(ConfigError) as caught:
        load_settings({**MINIMAL, "WEBHOOK_TOKEN": WEBHOOK["WEBHOOK_TOKEN"]})

    assert WEBHOOK["WEBHOOK_TOKEN"] not in repr(settings)
    assert WEBHOOK["WEBHOOK_TOKEN"] not in str(caught.value)


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/webhooks/partner",
        "https://example.com",
        "https://example.com:8443/hook?x=1",
        "http://localhost/hook",
        "http://localhost:3000/hook",
        "http://127.0.0.1:8080/hook",
        "http://[::1]:8080/hook",
        "http://host.docker.internal:9000/hook",
        "HTTP://LOCALHOST/hook",
    ],
)
def test_a_good_webhook_url_is_accepted(url):
    assert load_settings({**MINIMAL, **WEBHOOK, "WEBHOOK_URL": url}).webhook_url == url


@pytest.mark.parametrize(
    ("url", "why"),
    [
        ("http://example.com/hook", "must use https://"),
        ("http://localhost.evil.example/hook", "must use https://"),
        ("http://127.0.0.1.evil.example/hook", "must use https://"),
        ("http://192.168.1.10/hook", "must use https://"),
        ("ftp://example.com/hook", "must start with https://"),
        ("example.com/hook", "must start with https://"),
        ("//example.com/hook", "must start with https://"),
        ("https://", "must contain a host name"),
        ("https:///hook", "must contain a host name"),
        ("https://user:pass@example.com/hook", "must not contain a user name or password"),
        ("https://user@example.com/hook", "must not contain a user name or password"),
        ("http://localhost@evil.example/hook", "must not contain a user name or password"),
        ("https://example.com/hook#part", "must not contain a fragment"),
        ("https://example.com/hook#", "must not contain a fragment"),
        ("https://exa mple.com/hook", "must not contain spaces"),
        ("https://example.com/ho\tok", "must not contain spaces"),
        (
            "https://example.com\\@evil.example/",
            "must not contain spaces, control characters or backslashes",
        ),
        ("https://example.com:notaport/hook", "is not a valid URL"),
        ("https://example.com:99999/hook", "is not a valid URL"),
        ("http://[::1/hook", "is not a valid URL"),
    ],
)
def test_a_bad_webhook_url_is_refused_and_the_message_does_not_repeat_it(url, why):
    with pytest.raises(ConfigError) as caught:
        load_settings({**MINIMAL, **WEBHOOK, "WEBHOOK_URL": url})

    assert f"WEBHOOK_URL {why}" in str(caught.value)
    assert "pass@" not in str(caught.value) and "evil" not in str(caught.value)


# --- Start-up failures ------------------------------------------------------------------------


def test_the_application_exits_with_a_clear_message_on_bad_configuration(monkeypatch):
    monkeypatch.delenv("PARTNER_API_KEY", raising=False)

    with pytest.raises(SystemExit) as caught:
        create_app_from_env()

    assert "partner-sim cannot start" in str(caught.value)
    assert "PARTNER_API_KEY" in str(caught.value)


def test_the_application_starts_from_the_environment(monkeypatch, tmp_path):
    for name, value in {
        "PARTNER_API_KEY": API_KEY,
        "UI_USER": "u",
        "UI_PASSWORD": "p",
        "DB_PATH": str(tmp_path / "x.db"),
        "SCHEMA_DIR": str(SCHEMA_DIR),
    }.items():
        monkeypatch.setenv(name, value)

    assert create_app_from_env().title == "Partner simulator"


def test_the_application_exits_with_a_clear_message_when_the_schemas_are_missing(
    monkeypatch, tmp_path
):
    for name, value in {
        "PARTNER_API_KEY": "k",
        "UI_USER": "u",
        "UI_PASSWORD": "p",
        "DB_PATH": str(tmp_path / "x.db"),
        "SCHEMA_DIR": str(tmp_path / "no-such-folder"),
    }.items():
        monkeypatch.setenv(name, value)

    with pytest.raises(SystemExit) as caught:
        create_app_from_env()

    assert "cannot load schema" in str(caught.value)


@pytest.mark.parametrize("broken", ["submission.xsd", "reply.xsd", "event.xsd", "common-types.xsd"])
def test_a_missing_schema_file_stops_the_start_up(settings, tmp_path, broken):
    import dataclasses
    import shutil

    schema_dir = tmp_path / "xsd"
    shutil.copytree(SCHEMA_DIR, schema_dir)
    (schema_dir / broken).unlink()

    with pytest.raises(SchemaLoadError):
        create_app(dataclasses.replace(settings, schema_dir=schema_dir))


@pytest.mark.parametrize("broken", ["submission.xsd", "reply.xsd", "event.xsd", "common-types.xsd"])
def test_a_schema_file_that_is_not_a_schema_stops_the_start_up(settings, tmp_path, broken):
    import dataclasses
    import shutil

    schema_dir = tmp_path / "xsd"
    shutil.copytree(SCHEMA_DIR, schema_dir)
    (schema_dir / broken).write_text("<this is not <a schema")

    with pytest.raises(SchemaLoadError):
        create_app(dataclasses.replace(settings, schema_dir=schema_dir))


def test_a_well_formed_file_that_is_not_an_xsd_stops_the_start_up(settings, tmp_path):
    import dataclasses
    import shutil

    schema_dir = tmp_path / "xsd"
    shutil.copytree(SCHEMA_DIR, schema_dir)
    (schema_dir / "submission.xsd").write_text("<hello/>")

    with pytest.raises(SchemaLoadError):
        create_app(dataclasses.replace(settings, schema_dir=schema_dir))
