"""
Console output that survives a Windows terminal.

Python on Windows defaults stdout to the legacy ANSI code page (cp1252 on most machines), so printing
an arrow or a box-drawing character raises `UnicodeEncodeError` and takes the whole script down. That
is a poor way to end a demo, so: ask for UTF-8 first, and fall back to ASCII glyphs when the terminal
genuinely cannot do it (a redirected pipe, an old console host, a CI log).
"""

from __future__ import annotations

import sys


def _enable_utf8() -> None:
    """Switch the standard streams to UTF-8 where the runtime allows it."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            # A stream that refuses (some redirections) just keeps its encoding; GLYPHS picks ASCII.
            pass


def _supports(text: str) -> bool:
    encoding = getattr(sys.stdout, "encoding", None) or "ascii"
    try:
        text.encode(encoding)
    except (UnicodeEncodeError, LookupError):
        return False
    return True


_enable_utf8()

_UNICODE = {"arrow": "→", "rule": "─", "ok": "✓", "fail": "✗", "dot": "·", "ellipsis": "…", "ask": "⚠"}
_ASCII = {"arrow": "->", "rule": "-", "ok": "[ok]", "fail": "[!]", "dot": "*", "ellipsis": "...", "ask": "[?]"}

#: Glyphs safe to print on this terminal. Use these rather than literals in f-strings.
GLYPHS = _UNICODE if _supports("".join(_UNICODE.values())) else _ASCII


def rule(width: int = 78) -> str:
    return GLYPHS["rule"] * width
