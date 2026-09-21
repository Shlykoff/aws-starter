"""Hostile XML: DOCTYPE, external entities, entity expansion, deep nesting, network hints."""

import time

import pytest
from helpers import FIXTURES_DIR, all_rows, make_submission, reply_fields
from lxml import etree

from app import xml_input
from app.xml_input import DoctypeNotAllowed, MalformedXml, hardened_parser, parse_xml

XXE = FIXTURES_DIR / "submission" / "invalid" / "doctype-external-entity.xml"
EXPANSION = FIXTURES_DIR / "submission" / "invalid" / "doctype-entity-expansion.xml"


def valid_with_doctype(doctype: str) -> bytes:
    document = make_submission()
    declaration, rest = document.split(b"?>", 1)
    return declaration + b"?>\n" + doctype.encode() + rest


# --- Refused by policy (400, MALFORMED_XML), each in its own way --------------------------------


def test_the_external_entity_fixture_is_refused_and_nothing_of_the_file_leaks(
    post, client, settings, assert_valid_reply
):
    response = post(XXE.read_bytes())

    assert response.status_code == 400
    assert_valid_reply(response)
    assert reply_fields(response.content)["code"] == "MALFORMED_XML"
    (row,) = all_rows(settings.db_path)
    # /etc/passwd starts with "root:" on Linux and macOS alike. It must be nowhere: not in
    # the answer, not in what was stored, not on the page that shows it.
    page = client.get(f"/messages/{row['id']}", auth=("inbox-user", "inbox-password-not-a-secret"))
    for where in (response.text, row["reply_xml"], row["problems"], page.text):
        assert "root:" not in where


def test_the_entity_expansion_fixture_is_refused_quickly(post, settings):
    started = time.monotonic()

    response = post(EXPANSION.read_bytes())

    assert response.status_code == 400
    assert reply_fields(response.content)["code"] == "MALFORMED_XML"
    assert time.monotonic() - started < 2
    assert len(all_rows(settings.db_path)) == 1


@pytest.mark.parametrize(
    "doctype",
    [
        "<!DOCTYPE Submission>",  # the most harmless DOCTYPE there is: still refused
        '<!DOCTYPE Submission SYSTEM "http://127.0.0.1:9/evil.dtd">',  # an external DTD
        '<!DOCTYPE Submission PUBLIC "-//X//Y//EN" "http://127.0.0.1:9/evil.dtd">',
        '<!DOCTYPE Submission [<!ATTLIST Submission extra CDATA "x">]>',  # an attribute default
    ],
    ids=["plain", "external-dtd", "public-dtd", "internal-subset"],
)
def test_any_doctype_is_refused_even_on_an_otherwise_valid_document(post, doctype):
    response = post(valid_with_doctype(doctype))

    assert response.status_code == 400
    assert reply_fields(response.content)["code"] == "MALFORMED_XML"


def test_a_doctype_in_a_utf_16_document_is_refused(post):
    # In UTF-16 every character is two bytes, so a search of the raw bytes for "<!DOCTYPE"
    # finds nothing. The check on the parsed document has to catch it.
    document = (
        '<?xml version="1.0" encoding="UTF-16"?>'
        '<!DOCTYPE Submission [<!ENTITY x "y">]>'
        '<Submission xmlns="urn:aws-starter:submission:v1" version="1"/>'
    ).encode("utf-16")
    assert b"<!DOCTYPE" not in document

    response = post(document)

    assert response.status_code == 400
    assert reply_fields(response.content)["code"] == "MALFORMED_XML"


def test_the_raw_check_refuses_a_doctype_before_the_parser_sees_the_document(monkeypatch):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("the parser must not be reached")

    monkeypatch.setattr(xml_input.etree, "fromstring", fail_if_called)

    with pytest.raises(DoctypeNotAllowed) as caught:
        parse_xml(b'<?xml version="1.0"?>\n<!DOCTYPE a>\n<a/>')

    assert caught.value.line == 2


def test_the_parsed_document_is_inspected_for_a_doctype_too():
    document = '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'.encode("utf-16")

    with pytest.raises(DoctypeNotAllowed):
        parse_xml(document)


def test_a_doctype_marker_inside_a_comment_is_refused_too():
    # A known, deliberate over-reach of the raw check: it cannot tell a real DOCTYPE from
    # the same characters in a comment. "Any DOCTYPE at all" is refused; a false alarm is cheap.
    with pytest.raises(DoctypeNotAllowed):
        parse_xml(b"<a><!-- <!DOCTYPE --></a>")


# --- The parser on its own: what it does if the DOCTYPE guards were not there --------------------


def text_element(document: bytes) -> etree._Element:
    root = etree.fromstring(document, hardened_parser())
    return root.find(".//{urn:aws-starter:submission:v1}Text")


def test_the_parser_does_not_resolve_external_entities():
    text = text_element(XXE.read_bytes())

    # An unresolved entity stays an entity node with no text. A resolved one would hold the file.
    assert text.text is None
    assert [type(child) for child in text] == [etree._Entity]
    assert "root:" not in etree.tostring(text, encoding="unicode")


def test_the_parser_does_not_expand_entities():
    text = text_element(EXPANSION.read_bytes())

    assert text.text is None  # expanded, it would be a long string of "a"
    assert [type(child) for child in text] == [etree._Entity]


def test_a_very_deep_document_is_refused_because_huge_tree_is_off(post):
    depth = 400  # libxml2 stops at 256 levels unless huge_tree is switched on
    document = b"<a>" * depth + b"</a>" * depth

    response = post(document)

    assert response.status_code == 400
    assert reply_fields(response.content)["code"] == "MALFORMED_XML"


# --- Other malformed input -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [b"this is not xml at all", b"<a><b></a>", b"<a>", b"\xff\xfe\x00", b"<?xml version='1.0'?>"],
)
def test_malformed_input_is_refused(post, body):
    response = post(body)

    assert response.status_code == 400
    assert reply_fields(response.content)["code"] == "MALFORMED_XML"


def test_the_reply_to_malformed_xml_does_not_echo_the_input(post):
    response = post(b"<secret-element-name><b></secret-element-name>")

    assert response.status_code == 400
    assert "secret-element-name" not in response.text


def test_well_formed_but_not_a_submission_is_a_schema_error_not_a_malformed_one(post):
    response = post(b"<hello/>")

    assert response.status_code == 422
    assert reply_fields(response.content)["code"] == "SCHEMA_INVALID"


def test_a_schema_location_hint_in_the_document_is_never_followed(post):
    # xsi:schemaLocation lets a document name a schema to fetch. Nothing may be fetched:
    # the port below is closed, so following the hint would fail or hang.
    document = make_submission().replace(
        b'version="1"',
        b'version="1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        b' xsi:schemaLocation="urn:aws-starter:submission:v1 http://127.0.0.1:9/evil.xsd"',
        1,
    )

    response = post(document)

    assert response.status_code == 200


def test_pretty_print_returns_the_text_unchanged_when_it_cannot_be_parsed():
    hostile = '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;'

    assert xml_input.pretty_print(hostile) == hostile
    assert xml_input.pretty_print("<a><b>text</b></a>") == "<a>\n  <b>text</b>\n</a>\n"


def test_malformed_xml_exception_carries_a_line():
    with pytest.raises(MalformedXml) as caught:
        parse_xml(b"<a>\n<b>\n</a>")

    assert caught.value.line == 3
