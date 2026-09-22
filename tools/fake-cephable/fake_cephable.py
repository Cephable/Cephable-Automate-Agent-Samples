"""
A stand-in for the Cephable Automate HTTP Server.

Speaks enough of the real contract to run every sample in this repo end to end without the Cephable
desktop app — useful for developing a sample, for CI, and for trying one of these before you have a
Professional licence. It does **not** run a model: the "agent" is a fixed script that calls two of your
tools and then answers.

    python fake_cephable.py                 # listens on 127.0.0.1:4319
    python fake_cephable.py --port 4400
    python fake_cephable.py --scenario refuse-destructive

Then point a sample at it:

    export CEPHABLE_ENDPOINT=http://127.0.0.1:4319
    export CEPHABLE_AUTOMATE_KEY=fake-token-with-at-least-24-characters

It deliberately listens on 4319 rather than 4317, so a real Cephable on the default port keeps working
and the samples' port sweep still finds the real one first. Pin `CEPHABLE_ENDPOINT` to use this.

What it reproduces faithfully, because these are the things clients get wrong:

* Bearer auth on every route, `/health` included, and 401 before routing.
* `service: "cephable-agent"` on `/health`, so port discovery can tell it apart from other servers.
* The park/resume loop on `/v1/runs` → `awaiting_tool_results` → `/tool-results`.
* OpenAI `tools` in, `finish_reason: "tool_calls"` out, with the resume token folded into each
  `tool_call.id` and a resume recognised from echoed `role: "tool"` messages.
* A failed run as HTTP 500 carrying a complete record with `schemaVersion: 1`.
* 409 while a run is in flight, and the `busy` / `awaitingToolResults` flags on `/health`.

What it does not do: run a model, execute Cephable's own tools, honour `restrictToWorkspace`, or enforce
most validation. It logs what it received so you can see your request was shaped correctly.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List

TOKEN = "fake-token-with-at-least-24-characters"

#: Scripted "agents", one per sample — because each sample declares different tools, and a script that
#: calls tools the caller does not have only ever exercises the error path.
#:
#: Each entry is a list of rounds; each round is a list of tool calls the fake agent makes before it
#: parks. Pick one with `--script`.
SCRIPTS: Dict[str, Dict[str, Any]] = {
    # samples/python-langchain-tools
    "support": {
        "rounds": [
            [{"id": "client_tool_c1", "name": "lookup_order", "arguments": {"order_id": "4471"}}],
            [{"id": "client_tool_c2", "name": "get_policy", "arguments": {"topic": "late_shipment"}}],
        ],
        "answer": "\n".join([
            "SITUATION: Order 4471 is held; SW-200 is backordered and it is past its promised date.",
            "ENTITLEMENT: late_shipment allows a shipping refund plus a 15% credit for gold tier.",
            "ESCALATION: Yes - two prior complaints require a named owner.",
            "DRAFT REPLY:",
            "Hi Dana, your order is late and that is on us. ...",
        ]),
        "steps": [
            {"title": "Look up order", "toolName": "lookup_order"},
            {"title": "Read policy", "toolName": "get_policy"},
            {"title": "Respond to user", "toolName": "respond_to_user"},
        ],
    },
    # samples/nextjs-vercel-ai-ui — exercises both read tools and both UI tools.
    "incidents": {
        "rounds": [
            [{"id": "client_tool_i1", "name": "list_incidents", "arguments": {"openOnly": True}}],
            [{"id": "client_tool_i2", "name": "get_incident", "arguments": {"id": "INC-204"}}],
            [{
                "id": "client_tool_i3",
                "name": "render_timeline",
                "arguments": {"incident_ids": ["INC-204", "INC-207"]},
            }],
            [{
                "id": "client_tool_i4",
                "name": "draft_status_post",
                "arguments": {
                    "title": "Checkout delays on 14 September",
                    "body": (
                        "Between 09:04 and 12:20 UTC some checkouts failed and payment confirmations "
                        "were delayed. Both were caused by a configuration change we made, not by a "
                        "third party. All payments were processed correctly. We have raised the "
                        "connection ceiling and added an alert so this is caught before customers "
                        "notice."
                    ),
                },
            }],
        ],
        "answer": (
            "INC-204 and INC-207 share a root cause: the 09:00 deploy doubled outbound concurrency "
            "from payments-worker without raising the checkout-api connection pool ceiling, so the "
            "backlog and the 503s are two symptoms of one change. Timeline and a draft post are above."
        ),
        "steps": [
            {"title": "List incidents", "toolName": "list_incidents"},
            {"title": "Read incident", "toolName": "get_incident"},
            {"title": "Draw a timeline", "toolName": "render_timeline"},
            {"title": "Draft a status post", "toolName": "draft_status_post"},
            {"title": "Respond to user", "toolName": "respond_to_user"},
        ],
    },
    # A run with no caller tools at all, for testing the plain path.
    # samples/nextjs-ai-sdk-agent-loop - a read, then a tool the sample gates on approval.
    "refund": {
        "rounds": [
            [{"id": "client_tool_r1", "name": "lookup_order",
              "arguments": {"orderId": "A-1043"}}],
            [{"id": "client_tool_r2", "name": "issue_refund",
              "arguments": {"orderId": "A-1043",
                            "reason": "Carrier delay on an account with two prior late deliveries."}}],
        ],
        "answer": "A-1043 is delayed with UPS and the account has two prior late deliveries, so I "
                  "refunded it in full ($1,840.00). Nothing else on the account needs attention.",
        "steps": [
            {"title": "Look up order", "toolName": "lookup_order"},
            {"title": "Issue refund", "toolName": "issue_refund"},
            {"title": "Respond to user", "toolName": "respond_to_user"},
        ],
    },
    "plain": {
        "rounds": [],
        "answer": "Nothing to do here - this script declares no tool calls.",
        "steps": [{"title": "Respond to user", "toolName": "respond_to_user"}],
    },
}

SCRIPT: List[List[Dict[str, Any]]] = []
FINAL_TEXT = ""
STEPS: List[Dict[str, Any]] = []

BACKEND = {"flavorId": "vulkan", "accelerator": "vulkan", "cpuFallback": False}
USAGE = {"inputTokens": 5120, "outputTokens": 344, "generationMs": 8345, "ttftMs": 610, "tps": 41.2}

STATE: Dict[str, Any] = {"round": 0, "busy": False, "parked": False, "scenario": "happy"}
LOCK = threading.Lock()


def log(message: str) -> None:
    print("[fake] " + message, file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:
        pass  # we do our own, more useful logging

    # ── plumbing ─────────────────────────────────────────────────────────────

    def _json(self, status: int, body: Any) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        return self.headers.get("authorization", "") == "Bearer " + TOKEN

    def _body(self) -> Dict[str, Any]:
        length = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def _unauthorized(self) -> None:
        self._json(401, {"error": {"message": "Unauthorized", "type": "authentication_error"}})

    def _not_found(self) -> None:
        self._json(404, {"error": {"message": "Not found", "type": "not_found"}})

    # ── GET ──────────────────────────────────────────────────────────────────

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler naming
        if not self._authorized():
            return self._unauthorized()

        if self.path == "/health":
            return self._json(200, {
                "status": "ok",
                "service": "cephable-agent",
                "appVersion": "4.2.1-fake",
                "platform": sys.platform,
                "architecture": "x64",
                "osRelease": "0.0.0-fake",
                "cpu": "Fake CPU @ 0.0GHz",
                "logicalCpuCount": 16,
                "totalMemoryBytes": 68719476736,
                "workflowStatus": "executing-progress" if STATE["busy"] else "idle",
                "activeRequestId": "automate-run-fake" if STATE["busy"] else None,
                "modelName": "gemma-4-4b-it-Q4_K_M.gguf",
                "workerRunning": True,
                "busy": STATE["busy"],
                "awaitingToolResults": STATE["parked"],
                "workspace": "/tmp/fake-cephable-workspace",
                "backend": BACKEND,
                "contextSize": 16384,
                "launchModelSelectionError": None,
                "automateModelSelection": None,
            })

        if self.path == "/v1/models":
            return self._json(200, {"object": "list", "data": [
                {"id": "cephable-agent", "object": "model", "owned_by": "cephable"},
            ]})

        if self.path == "/v1/automate/models":
            return self._json(200, {
                "object": "list",
                "data": [{
                    "name": "Gemma 4 M", "family": "Gemma", "sizeCode": "M",
                    "parameterCountBillions": 4, "fileSizeMb": 2650,
                    "supportsTools": True, "availableForDevice": True,
                    "downloaded": True, "selected": True,
                }],
                "catalog": {"status": "ready", "modelCount": 1},
            })

        return self._not_found()

    # ── POST ─────────────────────────────────────────────────────────────────

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            return self._unauthorized()

        body = self._body()

        if self.path == "/v1/automate/cancel":
            with LOCK:
                was = STATE["busy"]
                STATE.update(round=0, busy=False, parked=False)
            log("cancel force=" + str(body.get("force")) + " (was busy=" + str(was) + ")")
            return self._json(200, {
                "stopped": was,
                "mode": "terminate" if body.get("force") else ("cancel" if was else "none"),
                "requestId": "automate-run-fake" if was else None,
                "workflowStatus": "idle",
            })

        if self.path == "/v1/automate/models/select":
            log("model select " + json.dumps(body))
            return self._json(200, {"selected": None, "models": []})

        if self.path == "/v1/runs":
            return self._start_run(body)

        if self.path.startswith("/v1/runs/") and self.path.endswith("/tool-results"):
            token = self.path[len("/v1/runs/"):-len("/tool-results")]
            return self._resume_run(token, body)

        if self.path == "/v1/chat/completions":
            return self._chat(body)

        return self._not_found()

    # ── native runs ──────────────────────────────────────────────────────────

    def _start_run(self, body: Dict[str, Any]) -> None:
        with LOCK:
            if STATE["busy"]:
                return self._json(409, {"error": {
                    "message": "The on-device assistant is already running or preparing (executing-progress)",
                    "type": "conflict"}})
            STATE.update(round=0, busy=True, parked=False)

        if not isinstance(body.get("prompt"), str) or not body["prompt"].strip():
            with LOCK:
                STATE.update(busy=False)
            return self._json(400, {"error": {
                "message": "prompt must be a non-empty string", "type": "invalid_request_error"}})

        client_tools = [t.get("name") for t in body.get("clientTools") or []]
        mcp_servers = [s.get("name") for s in body.get("mcpServers") or []]
        log("/v1/runs  prompt=" + repr(body["prompt"][:60]))
        log("          clientTools=" + str(client_tools) + " mcpServers=" + str(mcp_servers))
        log("          restrictToWorkspace=" + str(body.get("restrictToWorkspace"))
            + " allowDestructiveTools=" + str(body.get("allowDestructiveTools"))
            + " thinkingLevel=" + str(body.get("thinkingLevel"))
            + " answerContract=" + ("yes" if body.get("answerContract") else "no"))

        if STATE["scenario"] == "fail":
            with LOCK:
                STATE.update(busy=False)
            return self._json(500, self._failed_record(body))

        # No caller tools declared? Nothing to park on — answer immediately.
        if not client_tools:
            with LOCK:
                STATE.update(busy=False)
            return self._json(200, self._finished_record(body))

        with LOCK:
            STATE["parked"] = True
        return self._json(200, self._parked_record(body))

    def _resume_run(self, token: str, body: Dict[str, Any]) -> None:
        expected = "tok-" + str(STATE["round"])
        if not STATE["parked"] or token != expected:
            log("resume rejected: token=" + token + " expected=" + expected
                + " parked=" + str(STATE["parked"]))
            return self._json(404, {"error": {
                "message": "No suspended run matches that resume token. "
                           "It may have timed out or been cancelled.",
                "type": "not_found"}})

        results = body.get("results")
        if not isinstance(results, list):
            return self._json(400, {"error": {
                "message": "results must be an array", "type": "invalid_request_error"}})
        for index, result in enumerate(results):
            if not isinstance(result, dict) or not result.get("id"):
                return self._json(400, {"error": {
                    "message": "results[" + str(index) + "].id is required",
                    "type": "invalid_request_error"}})

        summary = [(r["id"], "result" if "result" in r else "error") for r in results]
        log("resume " + token + " with " + str(len(results)) + " result(s): " + str(summary))

        with LOCK:
            STATE["round"] += 1
            more = STATE["round"] < len(SCRIPT)
            STATE["parked"] = more
            STATE["busy"] = True if more else False

        if more:
            return self._json(200, self._parked_record(body))
        return self._json(200, self._finished_record(body))

    # ── chat completions ─────────────────────────────────────────────────────

    def _chat(self, body: Dict[str, Any]) -> None:
        messages = body.get("messages")
        if not isinstance(messages, list):
            return self._json(400, {"error": {
                "message": "messages must be an array", "type": "invalid_request_error"}})

        tool_messages = [m for m in messages if isinstance(m, dict) and m.get("role") == "tool"]
        if tool_messages:
            ids = [m.get("tool_call_id") for m in tool_messages]
            log("chat resume; tool_call_ids=" + str(ids))
            # The real server decodes the resume token out of the id. We only need the round count.
            rounds_done = len({i for i in ids if i})
            with LOCK:
                STATE["round"] = rounds_done
                more = rounds_done < len(SCRIPT)
                STATE.update(busy=more, parked=more)
            if more:
                return self._json(200, self._chat_tool_calls(rounds_done))
            return self._json(200, self._chat_final())

        latest = next((m for m in reversed(messages)
                       if isinstance(m, dict) and m.get("role") == "user"), None)
        if not latest or not isinstance(latest.get("content"), str):
            return self._json(400, {"error": {
                "message": "The latest user message must contain string content",
                "type": "invalid_request_error"}})

        declared = [t.get("function", {}).get("name") for t in body.get("tools") or []]
        log("/v1/chat/completions  prompt=" + repr(latest["content"][:60]))
        log("          tools=" + str(declared) + " cephable=" + json.dumps(body.get("cephable")))

        if not declared:
            with LOCK:
                STATE.update(busy=False, parked=False)
            return self._json(200, self._chat_final())

        with LOCK:
            STATE.update(round=0, busy=True, parked=True)
        return self._json(200, self._chat_tool_calls(0))

    # ── record builders ──────────────────────────────────────────────────────

    def _base(self, body: Dict[str, Any]) -> Dict[str, Any]:
        record = {
            "schemaVersion": 1,
            "requestId": "automate-run-fake",
            "startedAt": "2026-09-17T18:00:00.000Z",
            "model": "gemma-4-4b-it-Q4_K_M.gguf",
            "appVersion": "4.2.1-fake",
            "backend": BACKEND,
        }
        if body.get("taskId"):
            record["taskId"] = body["taskId"]
        return record

    def _parked_record(self, body: Dict[str, Any]) -> Dict[str, Any]:
        return {
            **self._base(body),
            "status": "awaiting_tool_results",
            "answer": "",
            "toolCalls": SCRIPT[STATE["round"]],
            "resumeToken": "tok-" + str(STATE["round"]),
            "completedAt": "2026-09-17T18:00:04.000Z",
            "durationMs": 4000,
            "steps": STEPS[: STATE["round"]],
            "usage": None,
        }

    def _finished_record(self, body: Dict[str, Any]) -> Dict[str, Any]:
        record = {
            **self._base(body),
            "status": "completed",
            "answer": FINAL_TEXT,
            "completedAt": "2026-09-17T18:00:37.000Z",
            "durationMs": 37000,
            "steps": STEPS,
            "usage": USAGE,
        }
        if body.get("answerContract"):
            record["finalAnswer"] = FINAL_TEXT
        return record

    def _failed_record(self, body: Dict[str, Any]) -> Dict[str, Any]:
        # An HTTP 500 that is NOT a server fault: the run happened and did not succeed.
        return {
            **self._base(body),
            "status": "failed",
            "answer": "",
            "errorCode": "TOOL_TIMEOUT",
            "completedAt": "2026-09-17T18:00:12.000Z",
            "durationMs": 12000,
            "steps": [{**STEPS[0], "status": "failed",
                       "resultSummary": "The fake server was started with --scenario fail"}],
            "usage": None,
        }

    def _chat_tool_calls(self, round_index: int) -> Dict[str, Any]:
        return {
            "id": "automate-run-fake",
            "object": "chat.completion",
            "created": 1789412568,
            "model": "cephable-agent",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        # The real server folds its resume token into the id; OpenAI clients echo it back
                        # verbatim, which is how a resume finds the parked run.
                        "id": "call_tok-" + str(round_index) + "." + call["id"],
                        "type": "function",
                        "function": {"name": call["name"],
                                     "arguments": json.dumps(call["arguments"])},
                    } for call in SCRIPT[round_index]],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
            "cephable": {"schemaVersion": 1, "status": "awaiting_tool_results",
                         "requestId": "automate-run-fake"},
        }

    def _chat_final(self) -> Dict[str, Any]:
        return {
            "id": "automate-run-fake",
            "object": "chat.completion",
            "created": 1789412568,
            "model": "cephable-agent",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": FINAL_TEXT},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 5120, "completion_tokens": 344, "total_tokens": 5464},
            "cephable": {
                "schemaVersion": 1, "requestId": "automate-run-fake", "status": "completed",
                "model": "gemma-4-4b-it-Q4_K_M.gguf", "appVersion": "4.2.1-fake",
                "durationMs": 41000, "backend": BACKEND,
                "usage": {"inputTokens": 5120, "outputTokens": 344},
                "steps": STEPS,
            },
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Fake Cephable Automate HTTP Server")
    parser.add_argument("--port", type=int, default=4319,
                        help="default 4319, so a real Cephable on 4317 is unaffected")
    parser.add_argument("--scenario", choices=["happy", "fail"], default="happy",
                        help="'fail' makes every run end as a failed record under HTTP 500")
    parser.add_argument("--script", choices=sorted(SCRIPTS), default="support",
                        help="which sample's tools the fake agent should call (default: support)")
    args = parser.parse_args()

    # Bind the chosen script into the module-level names the handlers read.
    global SCRIPT, FINAL_TEXT, STEPS
    chosen = SCRIPTS[args.script]
    SCRIPT = chosen["rounds"]
    FINAL_TEXT = chosen["answer"]
    STEPS = [
        {"id": f"s{index}", "index": index, "status": "success", **step}
        for index, step in enumerate(chosen["steps"])
    ]

    STATE["scenario"] = args.scenario
    log("listening on http://127.0.0.1:" + str(args.port)
        + "  scenario=" + args.scenario + "  script=" + args.script)
    log("the fake agent will call: "
        + (", ".join(call["name"] for round_ in SCRIPT for call in round_) or "(no tools)"))
    log("point a sample at it with:")
    log("  CEPHABLE_ENDPOINT=http://127.0.0.1:" + str(args.port))
    log("  CEPHABLE_AUTOMATE_KEY=" + TOKEN)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
