"""
The same support-triage agent, driven entirely through LangChain.

There is no Cephable-specific client code in the agent loop below. `ChatOpenAI` points at Cephable's
OpenAI-compatible route, `.bind_tools()` hands it our functions, and the standard tool-calling loop
works — because Cephable answers `finish_reason: "tool_calls"` and folds its resume token into each
`tool_call.id`, which LangChain echoes back verbatim.

    pip install -r requirements.txt
    python run_langchain.py

What it demonstrates:

* An existing LangChain application pointed at a local, on-device agent with a two-line change.
* `@tool`-decorated Python functions executing in this process as the agent calls them.
* Reading Cephable's native run record out of the response for the detail LangChain does not model —
  the real step list, token usage, which GGUF served it, and which accelerator.

Two settings are not optional, and both are about the fact that this is a real agent doing real work:

* `max_retries=0` — a retry either collides with the run it just started (409) or starts a duplicate.
* a very long `timeout` — an agent run takes tens of seconds to minutes, far past SDK defaults. An SDK
  that gives up does not stop the run; it keeps going inside Cephable.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any, Dict, List

from console import GLYPHS, rule  # must import before other printing

try:
    from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
    from langchain_core.tools import tool
    from langchain_openai import ChatOpenAI
except ImportError:  # pragma: no cover - guidance beats a traceback
    print(
        "LangChain is not installed. From this folder:\n"
        "  python -m venv .venv\n"
        "  .venv\\Scripts\\activate     (Windows)  |  source .venv/bin/activate   (macOS/Linux)\n"
        "  pip install -r requirements.txt",
        file=sys.stderr,
    )
    raise SystemExit(2)

from cephable_client import discover_endpoint
import tools as domain

DEFAULT_PROMPT = (
    "A customer has emailed about order 4471 asking why it has not arrived. "
    "Work out what is actually going on, decide what we are allowed to offer them under our policies, "
    "and draft a short reply in plain language that does not promise anything we cannot deliver."
)


# ── our functions, as LangChain tools ────────────────────────────────────────────────────────────
# Thin wrappers over `tools.py`. The docstring becomes the description the model sees, so it carries
# the same weight here as the JSON Schema `description` does on the native route.


@tool
def lookup_order(order_id: str) -> Dict[str, Any]:
    """Fetch one order by its id. Returns status, promised and shipped dates, carrier, tracking, line
    items with SKUs, the customer's name and tier, and an isLate flag. Use this before saying anything
    about an order's state."""
    return domain.lookup_order(order_id)


@tool
def lookup_customer(email_or_id: str) -> Dict[str, Any]:
    """Fetch one customer by email address or customer id. Returns tier, how long they have been a
    customer, prior complaint count, their order ids, lifetime value, and a needsNamedOwner flag that is
    true when policy requires a named human owner rather than a queue."""
    return domain.lookup_customer(email_or_id)


@tool
def check_inventory(sku: str) -> Dict[str, Any]:
    """Check stock for one SKU. Returns quantity on hand, whether it is backordered, and the restock
    date if there is one. Call this before promising any delivery date."""
    return domain.check_inventory(sku)


@tool
def get_policy(topic: str) -> Dict[str, str]:
    """Look up the company's written policy on a topic so you can apply it exactly instead of guessing.
    Valid topics: late_shipment, backorder, refund_window, escalation. Always call this before offering
    a refund, credit, or escalation."""
    return domain.get_policy(topic)


TOOLS = [lookup_order, lookup_customer, check_inventory, get_policy]
TOOLS_BY_NAME = {t.name: t for t in TOOLS}


class CephableRecordCapture:
    """
    Keeps the `cephable` field of the most recent response.

    Cephable returns its entire native run record — the real step list, token usage, which GGUF served
    the run, which accelerator — as a top-level `cephable` field on the chat completion. `langchain-
    openai` drops response fields it does not model, so reading it from `AIMessage.response_metadata`
    does not work (verified: only token_usage, model_name, finish_reason and friends survive).

    An httpx response hook is the least invasive way to get at it: the LangChain agent loop above stays
    exactly as it would be against any OpenAI-compatible endpoint, and we still see what a local agent
    can tell us that a cloud one cannot.
    """

    def __init__(self) -> None:
        self.latest: Dict[str, Any] | None = None

    def hook(self, response: Any) -> None:
        if response.status_code >= 400:
            return
        try:
            response.read()  # non-streaming, so the body is available here
            record = response.json().get("cephable")
        except Exception:  # noqa: BLE001 - diagnostics must never break the run
            return
        if isinstance(record, dict):
            self.latest = record


def build_model(endpoint: str, thinking: str, capture: CephableRecordCapture) -> Any:
    import httpx

    return ChatOpenAI(
        base_url=f"{endpoint}/v1",
        api_key=os.environ["CEPHABLE_AUTOMATE_KEY"],
        model="cephable-agent",  # ignored by Cephable; there is one assistant
        # Agent runs are long — far past SDK defaults. An SDK that gives up does not stop the run.
        timeout=930.0,
        # A retry either collides with the run it just started (409) or starts a duplicate.
        max_retries=0,
        # Sampling knobs are ignored by Cephable (the app's model profile governs them), but
        # `thinkingLevel` in the extension object is honored per run.
        extra_body={"cephable": {"thinkingLevel": thinking, "include": {"trace": False, "events": False}}},
        http_client=httpx.Client(
            timeout=httpx.Timeout(connect=5.0, read=930.0, write=30.0, pool=5.0),
            event_hooks={"response": [capture.hook]},
        ),
    ).bind_tools(TOOLS)


def run_agent_loop(model: Any, prompt: str, max_rounds: int = 25) -> tuple[str, List[BaseMessage]]:
    """
    The plain LangChain tool-calling loop. Nothing Cephable-aware in here.

    Each pass through the `tool_calls` branch is one parked Cephable run being resumed. Cephable keeps
    the run alive between them and holds its place in the agent loop, so the conversation we send back
    is what identifies which run to continue.
    """
    messages: List[BaseMessage] = [HumanMessage(prompt)]

    for _ in range(max_rounds):
        reply: AIMessage = model.invoke(messages)
        messages.append(reply)

        if not reply.tool_calls:
            content = reply.content if isinstance(reply.content, str) else str(reply.content)
            return content, messages

        for call in reply.tool_calls:
            name = call["name"]
            args = call.get("args") or {}
            rendered = ", ".join(f"{k}={v!r}" for k, v in args.items())
            print(f"  {GLYPHS['arrow']} agent called {name}({rendered})")

            selected = TOOLS_BY_NAME.get(name)
            if selected is None:
                output: Any = f"No tool named {name} is available."
            else:
                try:
                    output = selected.invoke(args)
                except Exception as error:  # noqa: BLE001 — the agent should see this and adapt
                    output = f"{type(error).__name__}: {error}"
            messages.append(ToolMessage(content=str(output), tool_call_id=call["id"]))

    raise RuntimeError(f"The agent did not settle within {max_rounds} tool rounds.")


def print_cephable_detail(record: Dict[str, Any] | None) -> None:
    """Show what a local agent can tell you that a cloud one cannot."""
    if not record:
        return

    backend = record.get("backend") or {}
    usage = record.get("usage") or {}
    print()
    print("Cephable run detail")
    print(f"  request id   {record.get('requestId')}")
    print(f"  status       {record.get('status')}")
    print(f"  model        {record.get('model')}  (on this machine, not a datacentre)")
    fallback = "  (CPU fallback!)" if backend.get("cpuFallback") else ""
    print(f"  accelerator  {backend.get('accelerator')}{fallback}")
    print(f"  duration     {record.get('durationMs', 0) / 1000:.1f}s")
    if usage:
        print(f"  tokens       {usage.get('inputTokens', 0)} in / {usage.get('outputTokens', 0)} out")

    steps = record.get("steps") or []
    if steps:
        print()
        print(f"  the agent's own {len(steps)} steps:")
        for step in steps:
            marker = {"success": GLYPHS["ok"], "failed": GLYPHS["fail"]}.get(step.get("status"), GLYPHS["dot"])
            print(f"    {marker} {step.get('title')}  [{step.get('toolName')}]")


def main() -> int:
    parser = argparse.ArgumentParser(description="Cephable support triage (LangChain)")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--thinking", choices=["low", "medium", "high", "max"], default="medium")
    args = parser.parse_args()

    if not os.environ.get("CEPHABLE_AUTOMATE_KEY"):
        print(
            "Set CEPHABLE_AUTOMATE_KEY first. Copy it from Cephable:\n"
            "  Extensions > Cephable features > Build & Extend > Automate HTTP Server",
            file=sys.stderr,
        )
        return 2

    try:
        endpoint = discover_endpoint()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1

    print(f"Cephable at {endpoint} - pointing LangChain's ChatOpenAI at {endpoint}/v1\n")
    capture = CephableRecordCapture()
    model = build_model(endpoint, args.thinking, capture)

    try:
        answer, _messages = run_agent_loop(model, args.prompt)
    except Exception as error:  # noqa: BLE001
        print(f"\nFailed: {type(error).__name__}: {error}", file=sys.stderr)
        print(
            "\nIf this was a 409, Cephable is already running something — including possibly a run the\n"
            "user started in the app's own panel. There is one inference slot.",
            file=sys.stderr,
        )
        return 1

    print("\n" + rule())
    print(answer.strip())
    print(rule())
    print_cephable_detail(capture.latest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
