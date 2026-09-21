"""XSD validation with lxml."""

import re
import threading
from pathlib import Path

from lxml import etree

from app.models import Finding

# lxml writes names as {namespace-uri}Name. The URI is noise for a human reader. A URI always
# contains a colon (urn:..., https://...), which is what tells it apart from the braces of a
# pattern such as \p{L}, which must stay as they are.
_NAMESPACE_IN_BRACES = re.compile(r"\{[^}:]*:[^}]*\}")


class SchemaLoadError(Exception):
    """A schema file is missing or broken. The application refuses to start."""


class SchemaValidator:
    """One loaded XSD, safe to call from many threads.

    Thread-safety, and the choice made: an lxml XMLSchema object keeps the errors of its
    latest validation in `error_log` on the object itself. Two threads validating at the same
    time would clear and fill the same log, and each could read the other's findings. The
    yes/no answer of validate() is safe, the findings are not. So validate() holds a lock
    while it validates AND while it copies the findings out. A lock instead of one schema
    object per thread because it is one `with` statement, the schema is loaded once, and
    validating a document of at most 64 KiB takes well under a millisecond; a simulator does
    not need more.
    """

    def __init__(self, xsd_path: Path) -> None:
        try:
            # The parser is hardened too. Imports inside the XSD (common-types.xsd) are
            # resolved by libxml2 from the path next to this file, never from the network.
            parser = etree.XMLParser(no_network=True, load_dtd=False, resolve_entities=False)
            self._schema = etree.XMLSchema(etree.parse(str(xsd_path), parser))
        except (OSError, etree.LxmlError) as exc:
            raise SchemaLoadError(f"cannot load schema {xsd_path}: {exc}") from exc
        self._lock = threading.Lock()

    def validate(self, root: etree._Element) -> list[Finding]:
        """Return the findings; an empty list means the document is valid."""
        with self._lock:
            if self._schema.validate(root):
                return []
            findings = [
                Finding(line=entry.line or None, message=_clean(entry.message))
                for entry in self._schema.error_log
            ]
        # Never let "invalid, but nothing to report" look like "valid".
        return findings or [Finding(line=None, message="The document does not match the schema")]


def _clean(message: str) -> str:
    return _NAMESPACE_IN_BRACES.sub("", message)
