"""
The support-triage agent, with the agent loop in YOUR code and Cephable as the model.

    pip install -r requirements.txt
    python run_agent.py                      # the demo: triage, a credit to approve, then a follow-up turn
    python run_agent.py --chat               # keep talking to it
    python run_agent.py --attach contract.md # put a long document in the conversation
    python run_agent.py --show-hidden        # see what Cephable did between your calls

Compare with ../python-langchain-tools, where Cephable's own desktop agent runs the loop and calls back into
your process for tools. Here the loop is a LangGraph graph (`agent.py`): your system prompt, your
conversation state, your tool execution, your approval gate. Cephable is `model="cephable-model"`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List

from console import GLYPHS, rule  # must import before other printing

try:
    import httpx
    from langchain_core.messages import AIMessageChunk, HumanMessage
    from langgraph.types import Command
except ImportError:  # pragma: no cover - guidance beats a traceback
    print(
        "LangChain / LangGraph are not installed. From this folder:\n"
        "  python -m venv .venv\n"
        "  .venv\\Scripts\\activate     (Windows)  |  source .venv/bin/activate   (macOS/Linux)\n"
        "  pip install -r requirements.txt",
        file=sys.stderr,
    )
    raise SystemExit(2)

from agent import build_graph, build_model
from cephable_endpoint import CephableSetupError, access_key, discover_endpoint, require_model_mode
import tools as domain

DEFAULT_PROMPT = (
    "Dana Whitfield (dana.whitfield@example.com) has emailed about order 4471 asking why it has not "
    "arrived. Work out what is going on, do whatever our policy entitles her to, and draft the reply."
)
DEFAULT_FOLLOW_UP = "Thanks. Now rewrite the draft reply as a formal letter I can post to her."

Approver = Callable[[Dict[str, Any]], Any]


class ModelCallLog:
    """
    httpx hooks that show what the loop sends and what comes back — without touching LangChain.

    The request side makes the point of this sample visible: every call carries the whole conversation,
    because the conversation lives here, not in Cephable. The response side (with --show-hidden) reads
    Cephable's run record, which model mode includes only when asked, to show the work it did unseen.
    """

    def __init__(self, show_hidden: bool) -> None:
        self.show_hidden = show_hidden
        self.records: List[Dict[str, Any]] = []

    def on_request(self, request: Any) -> None:
        try:
            body = json.loads(request.content or b"{}")
        except (ValueError, httpx.RequestNotRead):
            return
        messages = body.get("messages") or []
        roles = ", ".join(f"{count} {role}" for role, count in _count_roles(messages).items())
        print(f"  {GLYPHS['dot']} model call: {len(messages)} messages ({roles}), {len(body.get('tools') or [])} tools")

    def on_response(self, response: Any) -> None:
        if not self.show_hidden or response.status_code >= 400:
            return
        try:
            response.read()
            record = response.json().get("cephable")
        except Exception:  # noqa: BLE001 - diagnostics must never break the run
            return
        if isinstance(record, dict):
            self.records.append(record)
            for step in record.get("steps") or []:
                print(f"      {GLYPHS['dot']} inside Cephable: {step.get('title')}  [{step.get('toolName')}]")


def _count_roles(messages: List[Dict[str, Any]]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for message in messages:
        counts[message.get("role", "?")] = counts.get(message.get("role", "?"), 0) + 1
    return counts


def print_tool_call(name: str, args: Dict[str, Any]) -> None:
    rendered = ", ".join(f"{key}={value!r}" for key, value in args.items())
    print(f"  {GLYPHS['arrow']} {name}({rendered})")


def terminal_approver(auto_approve: bool) -> Approver:
    """Ask the person at the terminal. True approves; any other answer declines, with their note."""

    def approve(request: Dict[str, Any]) -> Any:
        args = request.get("args") or {}
        print(
            f"\n  {GLYPHS['ask']} approval needed: {request.get('tool')} — "
            f"{args.get('percent')}% of order {args.get('order_id')}\n"
            f"    reason: {args.get('reason')}"
        )
        if auto_approve:
            print("    approved (--yes)\n")
            return True
        if not sys.stdin.isatty():
            print("    declined: no one is at the terminal to approve it (pass --yes to approve)\n")
            return "No reviewer was available."
        answer = input("    approve? [y/N, or type a reason to decline] ").strip()
        print()
        return True if answer.lower() in {"y", "yes"} else (answer or False)

    return approve


def run_turn(graph: Any, config: Dict[str, Any], text: str, approve: Approver) -> str:
    """
    One user turn: stream the model's text as it arrives, pause for approval whenever the loop interrupts,
    and return the final answer.
    """
    inputs: Any = {"messages": [HumanMessage(text)]}
    streamed = False
    while True:
        pending = None
        for mode, chunk in graph.stream(inputs, config, stream_mode=["messages", "updates"]):
            if mode == "messages":
                message, metadata = chunk
                if metadata.get("langgraph_node") == "agent" and isinstance(message, AIMessageChunk) and message.content:
                    if not streamed:
                        print("\n" + rule())
                    print(message.content, end="", flush=True)
                    streamed = True
            elif mode == "updates" and "__interrupt__" in chunk:
                pending = chunk["__interrupt__"][0].value
        if pending is None:
            break
        inputs = Command(resume=approve(pending))

    answer = graph.get_state(config).values["messages"][-1].content
    answer = answer if isinstance(answer, str) else str(answer)
    if streamed:
        print("\n" + rule())
    else:
        print("\n" + rule() + "\n" + answer.strip() + "\n" + rule())
    return answer


def opening_message(prompt: str, attach: str | None) -> str:
    """The first user turn, with an attached document inlined the way a chat app would paste it."""
    if not attach:
        return prompt
    path = Path(attach)
    text = path.read_text(encoding="utf-8", errors="replace")
    print(f"Attaching {path.name} ({len(text):,} characters) to the first message.")
    # However long this is, send it as-is: Cephable saves long turns on its side and the model reads them
    # through its content tools, so there is nothing to chunk or truncate here.
    return f"{prompt}\n\nAttached document — {path.name}:\n\n{text}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Support triage: your LangGraph loop, Cephable as the model")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT, help="the first user message")
    parser.add_argument("--follow-up", default=DEFAULT_FOLLOW_UP, help="a second turn, to show the history is yours")
    parser.add_argument("--no-follow-up", action="store_true", help="stop after the first answer")
    parser.add_argument("--chat", action="store_true", help="keep the conversation going interactively")
    parser.add_argument("--attach", metavar="FILE", help="put a text file in the first message")
    parser.add_argument("--yes", action="store_true", help="approve credits without asking")
    parser.add_argument("--no-stream", action="store_true", help="wait for whole replies instead of streaming")
    parser.add_argument("--show-hidden", action="store_true", help="show the work Cephable did inside each model call")
    args = parser.parse_args()

    try:
        key = access_key()
        endpoint = discover_endpoint(key)
        require_model_mode(endpoint, key)
    except CephableSetupError as error:
        print(error, file=sys.stderr)
        return 1

    print(f"Cephable at {endpoint} {GLYPHS['dot']} LangGraph owns the loop {GLYPHS['dot']} model: cephable-model\n")

    log = ModelCallLog(show_hidden=args.show_hidden)
    http_client = httpx.Client(
        timeout=httpx.Timeout(connect=5.0, read=930.0, write=30.0, pool=5.0),
        event_hooks={"request": [log.on_request], "response": [log.on_response]},
    )
    # The run record rides on a non-streamed body, so --show-hidden trades streaming for visibility.
    streaming = not (args.no_stream or args.show_hidden)
    model = build_model(endpoint, key, streaming=streaming, show_hidden=args.show_hidden, http_client=http_client)
    graph = build_graph(model, on_tool_call=print_tool_call)
    config = {"configurable": {"thread_id": "support-desk"}, "recursion_limit": 25}
    approve = terminal_approver(args.yes)

    turns = [opening_message(args.prompt, args.attach)]
    if not args.no_follow_up and not args.chat and args.follow_up:
        turns.append(args.follow_up)

    try:
        for index, text in enumerate(turns):
            if index:
                print(f"\nYou: {text}")
            run_turn(graph, config, text, approve)
        while args.chat:
            try:
                text = input("\nYou: ").strip()
            except EOFError:
                break
            if text.lower() in {"", "exit", "quit"}:
                break
            run_turn(graph, config, text, approve)
    except KeyboardInterrupt:
        # Closing the connection is enough: Cephable cancels a model call whose client went away.
        print("\nStopped.", file=sys.stderr)
        return 130
    except Exception as error:  # noqa: BLE001
        print(f"\nFailed: {type(error).__name__}: {error}", file=sys.stderr)
        if "409" in str(error):
            print(
                "Cephable is already busy — possibly with a run the user started in the app. "
                "There is one inference slot on the device.",
                file=sys.stderr,
            )
        return 1

    if domain.CREDITS_ISSUED:
        print("\nCredits issued this session:")
        for credit in domain.CREDITS_ISSUED:
            print(f"  {credit['creditId']}  {credit['amount']:.2f} {credit['currency']} on order {credit['orderId']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
