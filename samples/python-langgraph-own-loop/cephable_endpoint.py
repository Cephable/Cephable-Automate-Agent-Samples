"""
Finding Cephable, and checking it can act as a model.

The one piece of Cephable-specific code this sample needs. Everything else talks to Cephable through
`langchain-openai` like any other OpenAI-compatible provider — but no SDK can tell you which port Cephable
bound, and an older Cephable without model mode would otherwise fail in a confusing way halfway through a
run. Standard library only.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple

DEFAULT_PORT = 4317
PORT_ATTEMPTS = 12
MODEL_ID = "cephable-model"


class CephableSetupError(RuntimeError):
    """Something to fix before the sample can run — reported as a sentence, not a traceback."""


def access_key() -> str:
    key = os.environ.get("CEPHABLE_AUTOMATE_KEY", "")
    if not key:
        raise CephableSetupError(
            "Set CEPHABLE_AUTOMATE_KEY first. Copy it from Cephable:\n"
            "  Extensions > Cephable features > Build & Extend > Automate HTTP Server"
        )
    return key


def _get(endpoint: str, route: str, key: str, timeout: float) -> Tuple[int, Dict[str, Any]]:
    request = urllib.request.Request(f"{endpoint}{route}", headers={"authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        return error.code, {}


def discover_endpoint(key: Optional[str] = None) -> str:
    """
    The endpoint Cephable is listening on.

    Cephable binds 4317 when it can and the next free port when it cannot, so a hardcoded address breaks
    the moment a second instance is running. `CEPHABLE_ENDPOINT` pins it (that is how you point this at
    the fake server).
    """
    key = key or access_key()
    pinned = os.environ.get("CEPHABLE_ENDPOINT")
    if pinned:
        return pinned.rstrip("/")

    for offset in range(PORT_ATTEMPTS):
        candidate = f"http://127.0.0.1:{DEFAULT_PORT + offset}"
        try:
            status, body = _get(candidate, "/health", key, timeout=3.0)
        except OSError:
            continue
        if status == 401:
            raise CephableSetupError(
                f"Cephable is listening on {candidate} but rejected the access key. "
                "It may have been regenerated — copy it again from the extension detail view."
            )
        # OpenTelemetry collectors also default to 4317, so only claim a find that is actually Cephable.
        if status == 200 and body.get("service") == "cephable-agent":
            return candidate

    raise CephableSetupError(
        f"No Cephable Automate server answered on 127.0.0.1:{DEFAULT_PORT}-{DEFAULT_PORT + PORT_ATTEMPTS - 1}.\n"
        "Open Cephable, enable Extensions > Cephable features > Build & Extend > Automate HTTP Server, and "
        "confirm its detail view says Running."
    )


def require_model_mode(endpoint: str, key: Optional[str] = None) -> None:
    """Fail early, and clearly, on a Cephable that predates model mode."""
    status, body = _get(endpoint, "/v1/models", key or access_key(), timeout=5.0)
    ids = {model.get("id") for model in body.get("data") or []}
    if status != 200 or MODEL_ID not in ids:
        raise CephableSetupError(
            f"This Cephable does not offer {MODEL_ID!r} (it lists {sorted(ids) or 'nothing'}). "
            "Model mode needs a newer Cephable desktop app — update it and try again."
        )
