"""SchemaValidator: findings, and sharing one schema object between many threads."""

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from helpers import FIXTURES_DIR, SCHEMA_DIR, make_submission
from lxml import etree

from app.validation import SchemaLoadError, SchemaValidator
from app.xml_input import parse_xml


@pytest.fixture(scope="module")
def submission_schema() -> SchemaValidator:
    return SchemaValidator(SCHEMA_DIR / "submission.xsd")


def test_a_valid_document_has_no_findings(submission_schema):
    assert submission_schema.validate(parse_xml(make_submission())) == []


def test_findings_have_a_line_and_no_namespace_noise(submission_schema):
    findings = submission_schema.validate(parse_xml(make_submission(subject="")))

    assert len(findings) == 1
    assert findings[0].line == 10
    assert findings[0].message.startswith("Element 'Subject': [facet 'minLength']")
    assert "{" not in findings[0].message


def test_a_pattern_keeps_its_own_braces_while_namespaces_are_stripped(submission_schema):
    invalid = parse_xml((FIXTURES_DIR / "submission/invalid/recipient-pattern.xml").read_bytes())

    findings = submission_schema.validate(invalid)

    assert len(findings) == 1
    # The namespace notation is gone, but \p{L} and \p{N} in the pattern are untouched.
    assert "urn:" not in findings[0].message
    assert r"\p{L}\p{N}" in findings[0].message


def test_a_file_that_is_not_a_schema_cannot_be_loaded():
    # (A missing common-types.xsd, which submission.xsd imports by a relative path, and other
    # broken schema sets are covered in test_config.py.)
    with pytest.raises(SchemaLoadError):
        SchemaValidator(Path(__file__))


def test_a_document_that_is_invalid_never_comes_back_with_an_empty_list(submission_schema):
    # `[]` means "valid". An invalid document must not be able to produce it.
    findings = submission_schema.validate(parse_xml(b"<hello/>"))

    assert findings != []


THREADS = 8
ROUNDS = 150


def test_one_schema_object_gives_every_thread_its_own_findings(submission_schema):
    """lxml keeps the error log on the schema object. Without the lock in validate(), threads
    validating at the same time clear and fill each other's log: an invalid document comes back
    with no findings, or with the findings of another thread's document."""
    invalid = parse_xml((FIXTURES_DIR / "submission/invalid/subject-empty.xml").read_bytes())
    other_invalid = parse_xml(
        (FIXTURES_DIR / "submission/invalid/recipient-pattern.xml").read_bytes()
    )
    valid = parse_xml(make_submission())
    start_together = threading.Barrier(THREADS)

    def hammer(n: int) -> list[str]:
        start_together.wait()
        mistakes = []
        for _ in range(ROUNDS):
            if submission_schema.validate(valid):
                mistakes.append("a valid document got findings")
            findings = submission_schema.validate(invalid if n % 2 else other_invalid)
            wanted = "Subject" if n % 2 else "pattern"
            if len(findings) != 1 or wanted not in findings[0].message:
                mistakes.append(f"expected one finding about {wanted}, got {findings}")
        return mistakes

    with ThreadPoolExecutor(max_workers=THREADS) as pool:
        results = list(pool.map(hammer, range(THREADS)))

    assert [m for mistakes in results for m in mistakes[:3]] == []


def test_parsing_from_many_threads_at_once_works():
    # parse_xml builds a new parser per call, so parsing from many threads shares nothing.
    def parse(_):
        return etree.tostring(parse_xml(make_submission()))

    with ThreadPoolExecutor(max_workers=THREADS) as pool:
        results = set(pool.map(parse, range(200)))

    assert len(results) == 1
