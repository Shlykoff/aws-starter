"""Comparing secrets."""

import secrets


def same_secret(given: str, expected: str) -> bool:
    """True when the two strings are equal, without leaking where they first differ.

    A plain `==` stops at the first different character, so the time it takes tells an
    attacker how much of a guess was right. `compare_digest` always looks at every byte.
    The strings are turned into bytes first because it only accepts ASCII text otherwise.
    (It still reveals the length; that is acceptable for a key of fixed, known length.)
    """
    return secrets.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))
