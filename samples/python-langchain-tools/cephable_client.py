"""
A small, dependency-free client for the Cephable Automate HTTP Server.

Standard library only, so `run_native.py` works in a bare virtualenv. The LangChain sample
(`run_langchain.py`) does not use this client at all — it talks to the OpenAI-compatible route through
`langchain-openai` — but it does borrow `discover_endpoint()`, because finding the port is the one piece
no SDK can do for you.

What this module handles that a naive `requests.post` does not:

* **Port discovery.** Cephable moves to the next free port when 4317 is taken, so a hardcoded endpoint
  silently breaks. We sweep the same window the app uses and confirm the `service` name.
* **Run vs. request failure.** A failed *run* comes back as HTTP 500 with a complete record. Only a body
  without `schemaVersion` means the request never started one.
* **The park/resume loop.** When the agent calls a tool you declared, the run parks and hands it to you.
  `run_with_tools()` drives that to completion.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence

DEFAULT_PORT = 4317
PORT_ATTEMPTS = 12
READY_STATUSES = {"idle", "terminated"}

#: A parked run gets two minutes per round before Cephable cancels it, so a handler that runs longer
#: than this will lose the run. Keep tool handlers fast; do slow work behind an inline MCP server.
TOOL_ROUND_BUDGET_SECONDS = 110


class CephableRequestError(RuntimeError):
    """The request never produced a run: 400, 401, 404, 409."""

    def __init__(self, message: str, status: int, error_type: Optional[str] = None) -> None:
        super().__init__(message)
        self.status = status
        self.error_type = error_type

    @property
    def is_busy(self) -> bool:
        """409 — a run is already going, possibly one the user started in the Cephable panel."""
        return self.status == 409

    @property
    def is_unauthorized(self) -> bool:
        return self.status == 401


class CephableRunError(RuntimeError):
    """A run happened and did not complete. Carries the full record for diagnosis."""

    def __init__(self, result: "RunResult") -> None:
        detail = f" ({result.error_code})" if result.error_code else ""
        super().__init__(f"Automate run {result.status}{detail}")
        self.result = result


@dataclass
class RunResult:
    """Thin, typed view over a run record. `raw` is always the untouched response."""

    raw: Dict[str, Any]

    @property
    def status(self) -> str:
        return self.raw["status"]

    @property
    def completed(self) -> bool:
        return self.raw["status"] == "completed"

    @property
    def awaiting_tool_results(self) -> bool:
        """Parked: the agent called a tool you declared and is waiting for the result."""
        return self.raw["status"] == "awaiting_tool_results"

    @property
    def answer(self) -> str:
        return self.raw.get("answer", "")

    @property
    def value(self) -> str:
        """The `answerContract` value when one was requested, otherwise the whole answer."""
        return self.raw.get("finalAnswer") or self.raw.get("answer", "")

    @property
    def error_code(self) -> Optional[str]:
        return self.raw.get("errorCode")

    @property
    def steps(self) -> List[Dict[str, Any]]:
        return self.raw.get("steps") or []

    @property
    def failed_steps(self) -> List[Dict[str, Any]]:
        return [step for step in self.steps if step.get("status") == "failed"]

    @property
    def tool_calls(self) -> List[Dict[str, Any]]:
        return self.raw.get("toolCalls") or []

    @property
    def produced_files(self) -> List[str]:
        """Resolved absolute paths this run created or edited. More reliable than parsing the answer."""
        return [step["producedFilePath"] for step in self.steps if step.get("producedFilePath")]

    @property
    def duration_ms(self) -> int:
        return self.raw.get("durationMs", 0)

    @property
    def usage(self) -> Optional[Dict[str, Any]]:
        return self.raw.get("usage")


@dataclass
class CephableClient:
    endpoint: Optional[str] = None
    token: str = field(default_factory=lambda: os.environ.get("CEPHABLE_AUTOMATE_KEY", ""))

    def __post_init__(self) -> None:
        if not self.token:
            raise ValueError(
                "No access key. Set CEPHABLE_AUTOMATE_KEY, or pass token=.\n"
                "Copy it from Cephable: Extensions > Cephable features > Build & Extend > "
                "Automate HTTP Server."
            )
        if self.endpoint is None:
            self.endpoint = os.environ.get("CEPHABLE_ENDPOINT") or None

    # ── transport ────────────────────────────────────────────────────────────────────────────────

    def resolve_endpoint(self) -> str:
        """
        Find and cache the endpoint.

        Cephable binds 4317 when it can and the next free port when it cannot, so a saved address can
        silently be wrong. Sweeping the same window turns "connection refused" into "it is over here".
        """
        if self.endpoint:
            return self.endpoint

        for offset in range(PORT_ATTEMPTS):
            candidate = f"http://127.0.0.1:{DEFAULT_PORT + offset}"
            try:
                status, body = self._raw_request(candidate, "/health", None, timeout=3.0)
            except OSError:
                continue  # nothing listening here; keep sweeping

            # A 401 still proves a server is listening — report the key problem, not a sweep failure.
            if status == 401:
                raise CephableRequestError(
                    f"Cephable is listening on {candidate} but rejected the access key. "
                    "It may have been regenerated — copy it again from the extension detail view.",
                    401,
                    "authentication_error",
                )
            # Only claim a find when it is actually Cephable: OpenTelemetry collectors also use 4317.
            if status == 200 and body.get("service") == "cephable-agent":
                self.endpoint = candidate
                return candidate

        raise RuntimeError(
            f"No Cephable Automate server answered on 127.0.0.1:{DEFAULT_PORT}-"
            f"{DEFAULT_PORT + PORT_ATTEMPTS - 1}.\n"
            "Open Cephable and enable Extensions > Cephable features > Build & Extend > "
            "Automate HTTP Server, then confirm its detail view says Running."
        )

    def _raw_request(
        self,
        endpoint: str,
        route: str,
        payload: Optional[Dict[str, Any]],
        timeout: float,
    ) -> tuple[int, Dict[str, Any]]:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            f"{endpoint}{route}",
            data=data,
            method="POST" if data is not None else "GET",
            headers={
                "authorization": f"Bearer {self.token}",
                "content-type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as error:
            # Every error the server returns has a JSON body worth reading — including the HTTP 500
            # that carries a complete record for a run that failed.
            raw = error.read().decode("utf-8")
            try:
                return error.code, json.loads(raw or "{}")
            except json.JSONDecodeError:
                return error.code, {"error": {"message": raw or error.reason}}

    def _request(
        self,
        route: str,
        payload: Optional[Dict[str, Any]] = None,
        timeout: float = 60.0,
    ) -> Dict[str, Any]:
        status, body = self._raw_request(self.resolve_endpoint(), route, payload, timeout)
        if status >= 400 and body.get("schemaVersion") != 1:
            error = body.get("error") or {}
            raise CephableRequestError(
                error.get("message", f"{route} returned HTTP {status}"),
                status,
                error.get("type"),
            )
        return body

    # ── endpoints ────────────────────────────────────────────────────────────────────────────────

    def health(self) -> Dict[str, Any]:
        return self._request("/health", timeout=10.0)

    def models(self) -> List[Dict[str, Any]]:
        return self._request("/v1/automate/models", timeout=15.0)["data"]

    def cancel(self, force: bool = False) -> Dict[str, Any]:
        """Always safe to call, even when nothing is running. Use it on your error path."""
        return self._request("/v1/automate/cancel", {"force": force}, timeout=30.0)

    def wait_until_ready(self, timeout: float = 300.0, poll: float = 1.0) -> Dict[str, Any]:
        """
        Block until the assistant is free.

        The app has one inference slot and shares it with the user's own panel, so this is the polite
        alternative to firing a request that gets a 409.
        """
        deadline = time.monotonic() + timeout
        health: Dict[str, Any] = {}
        while time.monotonic() < deadline:
            health = self.health()
            if not health.get("busy") and health.get("workflowStatus") in READY_STATUSES:
                return health
            time.sleep(poll)
        raise TimeoutError(
            f"Cephable stayed busy for {timeout:.0f}s "
            f"(last status: {health.get('workflowStatus')}, "
            f"awaiting tool results: {health.get('awaitingToolResults')})"
        )

    def run(
        self,
        prompt: str,
        *,
        task_id: Optional[str] = None,
        timeout_ms: int = 900_000,
        thinking_level: Optional[str] = None,
        additional_workflow_prompt: Optional[str] = None,
        answer_contract: Optional[str] = None,
        include_steps: bool = True,
        include_trace: bool = False,
        include_events: bool = False,
        restrict_to_workspace: bool = False,
        continuation: bool = False,
        selected_skill_ids: Optional[Sequence[str]] = None,
        selected_mcp_server_ids: Optional[Sequence[str]] = None,
        mcp_servers: Optional[List[Dict[str, Any]]] = None,
        client_tools: Optional[List[Dict[str, Any]]] = None,
        hitl_answers: Optional[Dict[str, Any]] = None,
        allow_destructive_tools: bool = False,
    ) -> RunResult:
        """
        Start one run and return its first outcome.

        That outcome is either the finished record or — when the agent calls one of `client_tools` — a
        parked record you resume with `resume_with_tool_results()`. Prefer `run_with_tools()` unless you
        want to drive the loop yourself.
        """
        payload: Dict[str, Any] = {
            "prompt": prompt,
            "timeoutMs": timeout_ms,
            "include": {"steps": include_steps, "trace": include_trace, "events": include_events},
            "restrictToWorkspace": restrict_to_workspace,
            "continuation": continuation,
            "allowDestructiveTools": allow_destructive_tools,
        }
        for key, value in (
            ("taskId", task_id),
            ("thinkingLevel", thinking_level),
            ("additionalWorkflowPrompt", additional_workflow_prompt),
            ("answerContract", answer_contract),
            ("selectedSkillIds", list(selected_skill_ids) if selected_skill_ids else None),
            ("selectedMcpServerIds", list(selected_mcp_server_ids) if selected_mcp_server_ids else None),
            ("mcpServers", mcp_servers),
            ("clientTools", client_tools),
            ("hitlAnswers", hitl_answers),
        ):
            if value:
                payload[key] = value

        # Keep our deadline above the server's so its own timeout wins. Undercutting it would abandon a
        # run that is still executing inside Cephable — and still holding the inference slot.
        body = self._request("/v1/runs", payload, timeout=timeout_ms / 1000 + 30)
        return RunResult(body)

    def run_or_raise(self, prompt: str, **kwargs: Any) -> RunResult:
        result = self.run(prompt, **kwargs)
        if not result.completed:
            raise CephableRunError(result)
        return result

    def resume_with_tool_results(
        self,
        resume_token: str,
        results: List[Dict[str, Any]],
        timeout: float = 930.0,
    ) -> RunResult:
        """Post results for a parked run and get its next outcome."""
        body = self._request(f"/v1/runs/{resume_token}/tool-results", {"results": results}, timeout=timeout)
        return RunResult(body)

    def run_with_tools(
        self,
        prompt: str,
        handlers: Dict[str, Callable[..., Any]],
        *,
        client_tools: Optional[List[Dict[str, Any]]] = None,
        on_tool_call: Optional[Callable[[str, Dict[str, Any]], None]] = None,
        max_rounds: int = 25,
        **kwargs: Any,
    ) -> RunResult:
        """
        Run a task with tools this process executes, driving the park/resume loop to completion.

        `handlers` maps tool name to a callable taking the tool's arguments as keywords. A handler that
        raises is reported to the agent as a failed tool call rather than killing the run — the agent
        then adapts or explains, which is nearly always more useful than a dead run.

        `max_rounds` is a seatbelt: a model that loops on one tool would otherwise ping-pong until the
        run's own timeout.
        """
        definitions = client_tools or [
            {"name": name, "description": f"The {name} tool"} for name in handlers
        ]
        result = self.run(prompt, client_tools=definitions, **kwargs)

        rounds = 0
        while result.awaiting_tool_results:
            rounds += 1
            if rounds > max_rounds:
                self.cancel(force=True)
                raise CephableRunError(result)

            results: List[Dict[str, Any]] = []
            for call in result.tool_calls:
                name = call["name"]
                args = call.get("arguments") or {}
                if on_tool_call:
                    on_tool_call(name, args)

                handler = handlers.get(name)
                if handler is None:
                    results.append({"id": call["id"], "error": f"No handler is registered for {name}"})
                    continue
                try:
                    results.append({"id": call["id"], "result": handler(**args)})
                except Exception as error:  # noqa: BLE001 — reported to the agent, not raised here
                    results.append({"id": call["id"], "error": f"{type(error).__name__}: {error}"})

            result = self.resume_with_tool_results(result.raw["resumeToken"], results)

        return result


def discover_endpoint(token: Optional[str] = None) -> str:
    """
    Find the Cephable endpoint without building a client.

    Used by the LangChain sample, which needs the base URL for `ChatOpenAI` but otherwise talks to
    Cephable entirely through the OpenAI-compatible route.
    """
    return CephableClient(token=token or os.environ.get("CEPHABLE_AUTOMATE_KEY", "")).resolve_endpoint()
