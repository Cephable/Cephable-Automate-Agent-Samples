"""
Support triage against Cephable's native /v1/runs route, with our own Python functions as tools.

Standard library only — no LangChain, no OpenAI SDK, nothing to install. Run this first if you want to
see the raw mechanics; `run_langchain.py` does the same job through LangChain.

    python run_native.py
    python run_native.py --order 4472
    python run_native.py --prompt "Priya Raman wants an invoice for her August order. What do we tell her?"

What it demonstrates:

* Port discovery and a readiness gate, instead of assuming 4317 and hoping nothing else is running.
* `clientTools` + the park/resume loop: the agent calls our functions, in our process, as often as it
  needs, and we watch each call land.
* An `answerContract`, so the closing message has a shape a program can act on.
* Honest failure handling: a failed run is an HTTP 500 carrying a complete record, not an exception.
"""

from __future__ import annotations

import argparse
import sys
import textwrap
from typing import Any, Dict

from console import GLYPHS, rule  # must import before other printing
from cephable_client import CephableClient, CephableRequestError, CephableRunError
from tools import CLIENT_TOOL_SCHEMAS, HANDLERS

DEFAULT_PROMPT = (
    "A customer has emailed about order 4471 asking why it has not arrived. "
    "Work out what is actually going on, decide what we are allowed to offer them under our policies, "
    "and draft a short reply in plain language that does not promise anything we cannot deliver."
)

ANSWER_CONTRACT = textwrap.dedent(
    """
    Structure your closing message exactly like this, with these four headings and nothing before them:

    SITUATION: one sentence on what is actually wrong.
    ENTITLEMENT: what policy allows us to offer, naming the policy.
    ESCALATION: whether this needs a named human owner, and why.
    DRAFT REPLY:
    <the message to send the customer>
    """
).strip()


def describe_environment(client: CephableClient) -> None:
    health = client.health()
    backend = health.get("backend") or {}
    print("Cephable")
    print(f"  endpoint      {client.resolve_endpoint()}")
    print(f"  app version   {health.get('appVersion')}  ({health.get('platform')}/{health.get('architecture')})")
    print(f"  model         {health.get('modelName')}")
    print(f"  accelerator   {backend.get('accelerator')}{'  (CPU fallback!)' if backend.get('cpuFallback') else ''}")
    print(f"  context       {health.get('contextSize')} tokens")
    print(f"  status        {health.get('workflowStatus')} (busy={health.get('busy')})")
    print()


def on_tool_call(name: str, args: Dict[str, Any]) -> None:
    """Print each call as it parks the run, so the loop is visible rather than magic."""
    rendered = ", ".join(f"{key}={value!r}" for key, value in args.items())
    print(f"  {GLYPHS['arrow']} agent called {name}({rendered})")


def main() -> int:
    parser = argparse.ArgumentParser(description="Cephable support triage (native /v1/runs)")
    parser.add_argument("--prompt", help="Override the built-in scenario")
    parser.add_argument("--order", help="Shorthand: triage this order id")
    parser.add_argument("--thinking", choices=["low", "medium", "high", "max"], default="medium")
    parser.add_argument("--timeout-ms", type=int, default=600_000)
    parser.add_argument("--raw", action="store_true", help="Print the full run record as JSON")
    args = parser.parse_args()

    prompt = args.prompt or (
        f"A customer has emailed about order {args.order} asking for a status update. "
        "Work out what is actually going on, decide what we are allowed to offer them under our "
        "policies, and draft a short reply that does not promise anything we cannot deliver."
        if args.order
        else DEFAULT_PROMPT
    )

    try:
        client = CephableClient()
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2

    try:
        describe_environment(client)

        print(f"Waiting for the assistant to be free{GLYPHS['ellipsis']}")
        client.wait_until_ready(timeout=120)

        print("Running. Tool calls will appear as the agent makes them:\n")
        result = client.run_with_tools(
            prompt,
            HANDLERS,
            client_tools=CLIENT_TOOL_SCHEMAS,
            on_tool_call=on_tool_call,
            task_id="support-triage-native",
            answer_contract=ANSWER_CONTRACT,
            thinking_level=args.thinking,
            timeout_ms=args.timeout_ms,
            # Our tools are read-only and the agent has no reason to touch the filesystem here, so there
            # is nothing to gain from letting it. Narrow by default.
            restrict_to_workspace=True,
        )
    except CephableRunError as error:
        print(f"\nThe run did not finish: {error.result.status} ({error.result.error_code})", file=sys.stderr)
        for step in error.result.failed_steps:
            print(f"  {step.get('toolName')}: {step.get('resultSummary')}", file=sys.stderr)
        return 1
    except CephableRequestError as error:
        if error.is_busy:
            print(
                "\nCephable is busy with another run - possibly one started from the app's own panel.\n"
                "Wait for it, or POST to /v1/automate/cancel",
                file=sys.stderr,
            )
        elif error.is_unauthorized:
            print("\nThe access key was rejected. Copy it again from the extension detail view.", file=sys.stderr)
        else:
            print(f"\nRequest failed ({error.status}): {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        # A run parked on our tools keeps the single inference slot after our request dies. Cancel it
        # explicitly.
        print("\nInterrupted. Cancelling the run inside Cephable.", file=sys.stderr)
        client.cancel(force=True)
        return 130

    if args.raw:
        import json

        print(json.dumps(result.raw, indent=2))
        return 0

    print("\n" + rule())
    print(result.value.strip())
    print(rule())

    usage = result.usage or {}
    print(
        f"\n{len(result.steps)} steps | {result.duration_ms / 1000:.1f}s | "
        f"{usage.get('outputTokens', 0)} output tokens"
        + (f" | {usage.get('tps', 0):.1f} tok/s" if usage.get("tps") else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
