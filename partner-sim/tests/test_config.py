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


@pytest.mark.parametrize("broken", ["submission.xsd", "reply.xsd", "common-types.xsd"])
def test_a_missing_schema_file_stops_the_start_up(settings, tmp_path, broken):
    import dataclasses
    import shutil

    schema_dir = tmp_path / "xsd"
    shutil.copytree(SCHEMA_DIR, schema_dir)
    (schema_dir / broken).unlink()

    with pytest.raises(SchemaLoadError):
        create_app(dataclasses.replace(settings, schema_dir=schema_dir))


@pytest.mark.parametrize("broken", ["submission.xsd", "reply.xsd", "common-types.xsd"])
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
