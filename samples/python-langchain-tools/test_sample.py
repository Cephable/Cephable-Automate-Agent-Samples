"""
Tests that run with no Cephable, no network, and no LangChain.

Two jobs:

1. Prove the domain tools and their schemas agree, so a typo in a schema does not surface as a baffling
   agent failure at demo time.
2. Prove the park/resume loop is driven correctly, against a fake transport. This is the piece most
   likely to be copied into someone's own client, and the piece with real sequencing to get wrong.

    python -m unittest test_sample -v
"""

from __future__ import annotations

import unittest
from typing import Any, Dict, List

import tools
from cephable_client import CephableClient, CephableRunError, RunResult


class DomainToolTests(unittest.TestCase):
    def test_lookup_order_derives_the_question_actually_being_asked(self) -> None:
        order = tools.lookup_order("4471")
        self.assertEqual(order["status"], "delayed")
        self.assertTrue(order["isLate"])
        self.assertEqual(order["customerName"], "Dana Whitfield")
        self.assertEqual(order["customerTier"], "gold")

    def test_a_shipped_order_is_not_late(self) -> None:
        self.assertFalse(tools.lookup_order("4472")["isLate"])

    def test_lookup_order_names_the_valid_ids_when_it_fails(self) -> None:
        # The agent sees this text. "Not found" alone teaches it to keep guessing.
        with self.assertRaises(LookupError) as caught:
            tools.lookup_order("9999")
        self.assertIn("4471", str(caught.exception))

    def test_lookup_customer_by_email_and_by_id(self) -> None:
        by_email = tools.lookup_customer("dana.whitfield@example.com")
        by_id = tools.lookup_customer("C-1001")
        self.assertEqual(by_email, by_id)

    def test_escalation_threshold_is_surfaced_not_inferred(self) -> None:
        self.assertTrue(tools.lookup_customer("C-1001")["needsNamedOwner"])
        self.assertFalse(tools.lookup_customer("C-1002")["needsNamedOwner"])

    def test_customer_rollups(self) -> None:
        priya = tools.lookup_customer("priya.raman@example.com")
        self.assertEqual(priya["orderIds"], ["4473"])
        self.assertEqual(priya["lifetimeValue"], 1780.0)

    def test_check_inventory_is_case_insensitive(self) -> None:
        self.assertEqual(tools.check_inventory("sw-200"), tools.check_inventory("SW-200"))
        self.assertTrue(tools.check_inventory("SW-200")["backordered"])

    def test_get_policy_accepts_the_shapes_a_model_actually_emits(self) -> None:
        for spelling in ("late_shipment", "late shipment", "Late-Shipment"):
            self.assertEqual(tools.get_policy(spelling)["topic"], "late_shipment")

    def test_get_policy_lists_topics_when_it_fails(self) -> None:
        with self.assertRaises(LookupError) as caught:
            tools.get_policy("refunds_maybe")
        self.assertIn("late_shipment", str(caught.exception))


class SchemaTests(unittest.TestCase):
    def test_every_schema_has_a_handler_and_vice_versa(self) -> None:
        schema_names = {schema["name"] for schema in tools.CLIENT_TOOL_SCHEMAS}
        self.assertEqual(schema_names, set(tools.HANDLERS))

    def test_schemas_satisfy_the_servers_validation_rules(self) -> None:
        for schema in tools.CLIENT_TOOL_SCHEMAS:
            with self.subTest(tool=schema["name"]):
                self.assertRegex(schema["name"], r"^[A-Za-z0-9_-]{1,64}$")
                self.assertFalse(schema["name"].startswith("mcp__"))  # reserved for MCP tools
                self.assertTrue(schema["description"].strip())
                self.assertLessEqual(len(schema["description"]), 1024)
                self.assertEqual(schema["parameters"]["type"], "object")

    def test_required_parameters_match_the_handler_signature(self) -> None:
        import inspect

        for schema in tools.CLIENT_TOOL_SCHEMAS:
            with self.subTest(tool=schema["name"]):
                expected = set(inspect.signature(tools.HANDLERS[schema["name"]]).parameters)
                self.assertEqual(set(schema["parameters"]["properties"]), expected)
                self.assertEqual(set(schema["parameters"]["required"]), expected)

    def test_openai_shape_wraps_the_same_declarations(self) -> None:
        openai = tools.openai_tool_schemas()
        self.assertEqual(len(openai), len(tools.CLIENT_TOOL_SCHEMAS))
        self.assertEqual(openai[0]["type"], "function")
        self.assertEqual(openai[0]["function"], tools.CLIENT_TOOL_SCHEMAS[0])


class FakeCephable(CephableClient):
    """
    A client whose transport is a scripted list of responses.

    Subclassing at `_request` keeps every layer above it — `run`, `resume_with_tool_results`,
    `run_with_tools` — exactly as shipped, so these tests exercise the real loop.
    """

    def __init__(self, responses: List[Dict[str, Any]]) -> None:
        super().__init__(endpoint="http://127.0.0.1:4317", token="x" * 24)
        self.responses = responses
        self.requests: List[tuple[str, Any]] = []

    def _request(self, route: str, payload: Any = None, timeout: float = 60.0) -> Dict[str, Any]:
        self.requests.append((route, payload))
        return self.responses.pop(0)


def parked(token: str, calls: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"schemaVersion": 1, "status": "awaiting_tool_results", "toolCalls": calls, "resumeToken": token}


def finished(answer: str) -> Dict[str, Any]:
    return {"schemaVersion": 1, "status": "completed", "answer": answer, "durationMs": 1000, "steps": []}


class ParkResumeLoopTests(unittest.TestCase):
    def test_drives_multiple_rounds_and_returns_the_final_record(self) -> None:
        client = FakeCephable(
            [
                parked("tok-1", [{"id": "c1", "name": "lookup_order", "arguments": {"order_id": "4471"}}]),
                parked("tok-2", [{"id": "c2", "name": "get_policy", "arguments": {"topic": "late_shipment"}}]),
                finished("Here is the draft."),
            ]
        )
        seen: List[str] = []

        result = client.run_with_tools(
            "triage order 4471",
            tools.HANDLERS,
            client_tools=tools.CLIENT_TOOL_SCHEMAS,
            on_tool_call=lambda name, _args: seen.append(name),
        )

        self.assertTrue(result.completed)
        self.assertEqual(result.answer, "Here is the draft.")
        self.assertEqual(seen, ["lookup_order", "get_policy"])

        routes = [route for route, _ in client.requests]
        self.assertEqual(
            routes,
            ["/v1/runs", "/v1/runs/tok-1/tool-results", "/v1/runs/tok-2/tool-results"],
        )

    def test_declares_our_tools_on_the_opening_request(self) -> None:
        client = FakeCephable([finished("done")])
        client.run_with_tools("hello", tools.HANDLERS, client_tools=tools.CLIENT_TOOL_SCHEMAS)
        _, payload = client.requests[0]
        self.assertEqual([t["name"] for t in payload["clientTools"]], list(tools.HANDLERS))

    def test_answers_with_the_id_the_server_supplied(self) -> None:
        client = FakeCephable(
            [
                parked("tok-1", [{"id": "call-abc", "name": "check_inventory", "arguments": {"sku": "SW-200"}}]),
                finished("done"),
            ]
        )
        client.run_with_tools("check stock", tools.HANDLERS, client_tools=tools.CLIENT_TOOL_SCHEMAS)
        _, payload = client.requests[1]
        self.assertEqual(payload["results"][0]["id"], "call-abc")
        self.assertIn("result", payload["results"][0])

    def test_a_raising_handler_becomes_a_tool_error_not_a_dead_run(self) -> None:
        client = FakeCephable(
            [
                parked("tok-1", [{"id": "c1", "name": "lookup_order", "arguments": {"order_id": "9999"}}]),
                finished("I could not find that order."),
            ]
        )

        result = client.run_with_tools("triage 9999", tools.HANDLERS, client_tools=tools.CLIENT_TOOL_SCHEMAS)

        self.assertTrue(result.completed)
        _, payload = client.requests[1]
        self.assertNotIn("result", payload["results"][0])
        self.assertIn("LookupError", payload["results"][0]["error"])

    def test_an_unknown_tool_name_is_reported_rather_than_crashing(self) -> None:
        client = FakeCephable(
            [
                parked("tok-1", [{"id": "c1", "name": "wire_money", "arguments": {}}]),
                finished("I do not have that tool."),
            ]
        )
        client.run_with_tools("do something odd", tools.HANDLERS, client_tools=tools.CLIENT_TOOL_SCHEMAS)
        _, payload = client.requests[1]
        self.assertIn("No handler is registered", payload["results"][0]["error"])

    def test_several_calls_in_one_round_are_answered_together(self) -> None:
        client = FakeCephable(
            [
                parked(
                    "tok-1",
                    [
                        {"id": "c1", "name": "lookup_order", "arguments": {"order_id": "4471"}},
                        {"id": "c2", "name": "check_inventory", "arguments": {"sku": "SW-200"}},
                    ],
                ),
                finished("done"),
            ]
        )
        client.run_with_tools("triage", tools.HANDLERS, client_tools=tools.CLIENT_TOOL_SCHEMAS)
        _, payload = client.requests[1]
        self.assertEqual({r["id"] for r in payload["results"]}, {"c1", "c2"})

    def test_a_looping_model_is_stopped_by_the_round_seatbelt(self) -> None:
        # A model that never stops calling the same tool would otherwise ping-pong until the run's own
        # timeout, holding the single inference slot the whole time.
        forever = [parked(f"tok-{i}", [{"id": "c", "name": "get_policy", "arguments": {"topic": "backorder"}}]) for i in range(6)]
        client = FakeCephable(forever + [{"stopped": True, "mode": "terminate"}])

        with self.assertRaises(CephableRunError):
            client.run_with_tools(
                "loop", tools.HANDLERS, client_tools=tools.CLIENT_TOOL_SCHEMAS, max_rounds=3
            )
        # …and it cancels rather than abandoning the run.
        self.assertEqual(client.requests[-1][0], "/v1/automate/cancel")


class RunResultTests(unittest.TestCase):
    def test_value_prefers_the_contract_answer(self) -> None:
        self.assertEqual(
            RunResult({"status": "completed", "answer": "blah FINAL ANSWER: 42", "finalAnswer": "42"}).value,
            "42",
        )

    def test_value_falls_back_to_the_whole_answer(self) -> None:
        self.assertEqual(RunResult({"status": "completed", "answer": "hello"}).value, "hello")

    def test_produced_files_reads_resolved_paths_off_the_steps(self) -> None:
        result = RunResult(
            {
                "status": "completed",
                "steps": [
                    {"status": "success", "producedFilePath": "C:\\out\\a.md"},
                    {"status": "success"},
                ],
            }
        )
        self.assertEqual(result.produced_files, ["C:\\out\\a.md"])


if __name__ == "__main__":
    unittest.main()
