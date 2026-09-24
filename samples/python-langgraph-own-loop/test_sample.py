"""
Tests that need no Cephable and no network.

The domain tests need nothing installed. The loop tests run the real LangGraph graph — real `ChatOpenAI`,
real HTTP, streaming included — against the repo's fake Cephable server started in this process, and skip
when LangGraph is not installed.

    python -m unittest test_sample -v
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List

import tools

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "fake-cephable"))
import fake_cephable  # noqa: E402

try:
    import httpx  # noqa: F401
    import langgraph  # noqa: F401
    import langchain_openai  # noqa: F401

    HAVE_LANGGRAPH = True
except ImportError:
    HAVE_LANGGRAPH = False


class DomainToolTests(unittest.TestCase):
    def setUp(self) -> None:
        tools.CREDITS_ISSUED.clear()

    def test_issue_credit_computes_the_amount_from_the_order_total(self) -> None:
        credit = tools.issue_credit("4471", 15, "late_shipment policy")
        self.assertEqual(credit["amount"], 37.2)
        self.assertEqual(credit["creditId"], "CR-0001")
        self.assertEqual(tools.CREDITS_ISSUED, [credit])

    def test_issue_credit_enforces_its_own_limits(self) -> None:
        # The loop's approval gate is a second line of defence, not the only one.
        with self.assertRaises(ValueError):
            tools.issue_credit("4471", 40, "too generous")
        with self.assertRaises(ValueError):
            tools.issue_credit("4471", 10, "  ")
        with self.assertRaises(LookupError):
            tools.issue_credit("9999", 10, "no such order")
        self.assertEqual(tools.CREDITS_ISSUED, [])

    def test_lookups_still_name_valid_ids_when_they_fail(self) -> None:
        with self.assertRaises(LookupError) as caught:
            tools.lookup_order("9999")
        self.assertIn("4471", str(caught.exception))


def _serve(server: ThreadingHTTPServer) -> str:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


@unittest.skipUnless(HAVE_LANGGRAPH, "LangGraph is not installed — pip install -r requirements.txt")
class LoopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        fake_cephable.log = lambda _message: None  # its request log is for people, not test output
        cls.server = fake_cephable.serve(0)
        cls.endpoint = _serve(cls.server)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        fake_cephable.use_script("own-loop")
        tools.CREDITS_ISSUED.clear()

    def _run(self, *turns: str, approval: Any = True, streaming: bool = True, show_hidden: bool = False):
        import httpx

        from agent import build_graph, build_model
        from run_agent import ModelCallLog, run_turn

        log = ModelCallLog(show_hidden=show_hidden)
        client = httpx.Client(event_hooks={"request": [log.on_request], "response": [log.on_response]})
        model = build_model(
            self.endpoint, fake_cephable.TOKEN, streaming=streaming, show_hidden=show_hidden, http_client=client
        )
        called: List[str] = []
        graph = build_graph(model, on_tool_call=lambda name, _args: called.append(name))
        config = {"configurable": {"thread_id": self.id()}, "recursion_limit": 25}
        approvals: List[Dict[str, Any]] = []

        def approve(request: Dict[str, Any]) -> Any:
            approvals.append(request)
            return approval

        answers = []
        with contextlib.redirect_stdout(io.StringIO()):
            for text in turns:
                answers.append(run_turn(graph, config, text, approve))
        return answers, called, approvals, graph.get_state(config).values["messages"], log

    def test_the_loop_is_ours_and_cephable_is_only_the_model(self) -> None:
        answers, called, approvals, _messages, _log = self._run("Why hasn't order 4471 arrived?")

        self.assertEqual(answers[0].strip(), fake_cephable.FINAL_TEXT.strip())
        # Our process ran every tool, the parallel pair included, and the gated one only after approval.
        self.assertEqual(called, ["lookup_order", "lookup_customer", "get_policy", "issue_credit"])
        self.assertEqual([a["tool"] for a in approvals], ["issue_credit"])
        self.assertEqual(len(tools.CREDITS_ISSUED), 1)

        requests = fake_cephable.RECEIVED
        self.assertEqual({body["model"] for body in requests}, {"cephable-model"})
        self.assertTrue(all(body.get("stream") is True for body in requests))
        from agent import SYSTEM_PROMPT

        for body in requests:
            self.assertEqual(body["messages"][0], {"role": "system", "content": SYSTEM_PROMPT})
            self.assertEqual(len(body["tools"]), 5)
        # Stateless model: every call carries the whole conversation so far.
        sizes = [len(body["messages"]) for body in requests]
        self.assertEqual(sizes, sorted(sizes))
        self.assertEqual(sizes, [2, 4, 7, 9])
        # Both answers to the parallel calls went back in one request.
        self.assertEqual([m["role"] for m in requests[2]["messages"]][-2:], ["tool", "tool"])

    def test_a_declined_credit_never_runs_and_the_model_is_told(self) -> None:
        _answers, called, _approvals, messages, _log = self._run("Why hasn't order 4471 arrived?", approval="Too generous")

        self.assertNotIn("issue_credit", called)
        self.assertEqual(tools.CREDITS_ISSUED, [])
        declined = next(m for m in messages if getattr(m, "name", None) == "issue_credit")
        self.assertIn("declined", declined.content)
        self.assertIn("Too generous", declined.content)

    def test_a_follow_up_turn_resends_the_earlier_one(self) -> None:
        answers, _called, _approvals, _messages, _log = self._run(
            "Why hasn't order 4471 arrived?", "Now make it a formal letter."
        )

        self.assertEqual(answers[1], fake_cephable.FOLLOW_UP_TEXT)
        last = fake_cephable.RECEIVED[-1]["messages"]
        self.assertEqual([m["content"] for m in last if m["role"] == "user"][-1], "Now make it a formal letter.")
        self.assertEqual(sum(1 for m in last if m["role"] == "user"), 2)
        self.assertIn(fake_cephable.FINAL_TEXT.strip(), [(m.get("content") or "").strip() for m in last])

    def test_show_hidden_asks_for_the_run_record_and_reads_it(self) -> None:
        _answers, _called, _approvals, _messages, log = self._run(
            "Why hasn't order 4471 arrived?", streaming=False, show_hidden=True
        )

        self.assertTrue(all(body["cephable"]["include"]["steps"] for body in fake_cephable.RECEIVED))
        self.assertTrue(log.records)
        self.assertEqual(log.records[-1]["mode"], "model")

    def test_without_show_hidden_there_is_no_cephable_record(self) -> None:
        _answers, _called, _approvals, _messages, log = self._run(
            "Why hasn't order 4471 arrived?", streaming=False
        )
        self.assertNotIn("cephable", fake_cephable.RECEIVED[0])
        self.assertEqual(log.records, [])


class _OldCephable(BaseHTTPRequestHandler):
    """A Cephable that predates model mode: it only lists the assistant."""

    def do_GET(self) -> None:  # noqa: N802
        body = json.dumps({"object": "list", "data": [{"id": "cephable-agent"}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        pass


class EndpointTests(unittest.TestCase):
    def test_a_pinned_endpoint_is_used_as_is(self) -> None:
        from cephable_endpoint import discover_endpoint

        with _env(CEPHABLE_ENDPOINT="http://127.0.0.1:4319/", CEPHABLE_AUTOMATE_KEY="k" * 30):
            self.assertEqual(discover_endpoint(), "http://127.0.0.1:4319")

    def test_an_old_cephable_is_reported_before_the_run_starts(self) -> None:
        from cephable_endpoint import CephableSetupError, require_model_mode

        server = ThreadingHTTPServer(("127.0.0.1", 0), _OldCephable)
        endpoint = _serve(server)
        try:
            with self.assertRaises(CephableSetupError) as caught:
                require_model_mode(endpoint, "k" * 30)
            self.assertIn("newer Cephable", str(caught.exception))
        finally:
            server.shutdown()
            server.server_close()

    def test_a_missing_key_is_a_sentence_not_a_traceback(self) -> None:
        from cephable_endpoint import CephableSetupError, access_key

        with _env(CEPHABLE_AUTOMATE_KEY=None):
            with self.assertRaises(CephableSetupError):
                access_key()


@contextlib.contextmanager
def _env(**values: Any):
    saved = {key: os.environ.get(key) for key in values}
    for key, value in values.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
