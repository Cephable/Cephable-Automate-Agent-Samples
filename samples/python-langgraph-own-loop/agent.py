"""
The agent: a LangGraph loop you own, with Cephable as the model inside it.

    START ─▶ agent ──(tool calls?)──▶ tools ──▶ agent ─▶ … ─▶ END
                 └────(no)──────────────────────────────────▲

Everything that makes this an *agent* lives in this file, in your code:

* **The system prompt** — the model's identity and output format. Cephable uses it as-is.
* **The conversation** — held by LangGraph's checkpointer and sent in full on every model call, the way you
  would call any chat model. Cephable keeps no state between calls.
* **The tools, and when they run** — `tools_node` executes them in this process, and refuses to run
  `issue_credit` until a human approves it (a LangGraph `interrupt`).
* **The stopping rule** — the graph's recursion limit.

Cephable contributes the model — `model="cephable-model"` on its OpenAI-compatible route — and, invisibly, its
content handling: a long message or tool result is saved on Cephable's side and read back in full by its own
summarize / generate tools, so a small on-device context window can still work from a large document. None
of that shows up here. From LangGraph's point of view it is one model call in, one AI message out.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.types import interrupt

import tools as domain

SYSTEM_PROMPT = """You are the support-triage assistant for Acme Adaptive, a company that sells adaptive \
switches and mounts. You help a support agent answer customer emails.

Look facts up with your tools before stating them — you have no memory of orders, customers, stock or \
policy. Apply the written policy exactly; never promise a delivery date for an item that is not in stock. \
When policy entitles the customer to a credit, issue it with issue_credit (a human approves it first; if \
they decline, say so and do not claim it was issued).

Answer with exactly these four headings, in this order, and nothing before them:
SITUATION: one or two sentences on what is actually going on.
ACTION TAKEN: what you did (credits issued, or "None").
ESCALATION: Yes or No, and why.
DRAFT REPLY: a short, warm reply to the customer in plain language."""

#: Tools that change something. The loop asks a human before running any of these.
GATED_TOOLS = {"issue_credit"}


# ── the tools, as LangChain tools ────────────────────────────────────────────────────────────────
# The docstring is the description the model sees. Say what the tool returns and when to call it.


@tool
def lookup_order(order_id: str) -> Dict[str, Any]:
    """Fetch one order by its id. Returns status, promised and shipped dates, carrier, tracking, line
    items with SKUs, the total, the customer's name and tier, and an isLate flag. Use this before saying
    anything about an order's state."""
    return domain.lookup_order(order_id)


@tool
def lookup_customer(email_or_id: str) -> Dict[str, Any]:
    """Fetch one customer by email address or customer id (e.g. C-1001). Returns tier, tenure, prior
    complaint count, order ids, lifetime value, and a needsNamedOwner flag that is true when policy
    requires a named human owner rather than a queue."""
    return domain.lookup_customer(email_or_id)


@tool
def check_inventory(sku: str) -> Dict[str, Any]:
    """Check stock for one SKU. Returns quantity on hand, whether it is backordered, and the restock
    date if there is one. Call this before promising any delivery date."""
    return domain.check_inventory(sku)


@tool
def get_policy(topic: str) -> Dict[str, str]:
    """Look up the written policy on a topic so you can apply it exactly. Valid topics: late_shipment,
    backorder, refund_window, escalation. Always call this before offering a refund, credit or escalation."""
    return domain.get_policy(topic)


@tool
def issue_credit(order_id: str, percent: float, reason: str) -> Dict[str, Any]:
    """Credit a percentage (at most 25) of an order's total back to the customer, citing the policy that
    allows it in reason. Requires human approval; returns the credit id and amount when approved."""
    return domain.issue_credit(order_id, percent, reason)


TOOLS = [lookup_order, lookup_customer, check_inventory, get_policy, issue_credit]
TOOLS_BY_NAME = {t.name: t for t in TOOLS}


# ── the model ────────────────────────────────────────────────────────────────────────────────────


def build_model(
    endpoint: str,
    api_key: str,
    *,
    streaming: bool = True,
    show_hidden: bool = False,
    http_client: Any = None,
) -> Any:
    """
    Cephable as a LangChain chat model. The only Cephable-specific value here is the model id.

    * `model="cephable-model"` selects model mode: Cephable answers as a model and leaves the agent loop to
      you. (`cephable-agent` would run Cephable's own desktop agent instead.)
    * `temperature` is honored in model mode, as are `top_p`, `max_tokens` and `response_format`.
    * `max_retries=0` — there is one inference slot on the device, so a retry collides with the request it
      is retrying (409) rather than helping.
    * A long timeout — a turn that reads a long document through Cephable's content tools takes a while.
      Streaming sends headers at once and a heartbeat every ten seconds, so idle timeouts never fire.
    """
    extra_body: Optional[Dict[str, Any]] = None
    if show_hidden:
        # Model mode leaves Cephable's run record out of the response; asking for steps puts it back.
        extra_body = {"cephable": {"include": {"steps": True, "trace": False, "events": False}}}

    return ChatOpenAI(
        model="cephable-model",
        base_url=f"{endpoint}/v1",
        api_key=api_key,
        temperature=0.2,
        timeout=900,
        max_retries=0,
        streaming=streaming,
        stream_usage=streaming,
        extra_body=extra_body,
        http_client=http_client,
    ).bind_tools(TOOLS)


# ── the graph ────────────────────────────────────────────────────────────────────────────────────


def build_graph(
    model: Any,
    *,
    on_tool_call: Optional[Callable[[str, Dict[str, Any]], None]] = None,
    checkpointer: Any = None,
) -> Any:
    """
    Compile the loop. `on_tool_call(name, args)` is told about every tool call before it runs — the CLI
    prints them — except a gated call a human declined, which never runs. The checkpointer holds each
    conversation between turns, and across an approval pause.
    """

    def agent_node(state: MessagesState) -> Dict[str, List[Any]]:
        # The whole conversation, every time, with our system prompt first. That is all a model needs.
        reply = model.invoke([SystemMessage(SYSTEM_PROMPT), *state["messages"]])
        return {"messages": [reply]}

    def tools_node(state: MessagesState) -> Dict[str, List[Any]]:
        calls = state["messages"][-1].tool_calls

        # Ask about every gated call BEFORE running anything. An interrupt re-runs this node from the top
        # when it resumes, so running the reads first would run them twice.
        approvals: Dict[str, Any] = {}
        for call in calls:
            if call["name"] in GATED_TOOLS:
                approvals[call["id"]] = interrupt({"tool": call["name"], "args": call.get("args") or {}})

        results: List[ToolMessage] = []
        for call in calls:
            name, args = call["name"], call.get("args") or {}
            approval = approvals.get(call["id"])
            if on_tool_call and (name not in GATED_TOOLS or approval is True):
                on_tool_call(name, args)
            content = _run_tool(name, args, approval)
            results.append(ToolMessage(content=content, tool_call_id=call["id"], name=name))
        return {"messages": results}

    def route(state: MessagesState) -> str:
        last = state["messages"][-1]
        return "tools" if isinstance(last, AIMessage) and last.tool_calls else END

    graph = StateGraph(MessagesState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tools_node)
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", route, ["tools", END])
    graph.add_edge("tools", "agent")
    return graph.compile(checkpointer=checkpointer or MemorySaver())


def _run_tool(name: str, args: Dict[str, Any], approval: Any) -> str:
    """Run one tool and render its result for the model. Failures become results the model can read."""
    if name in GATED_TOOLS and approval is not True:
        note = f" Their note: {approval}" if isinstance(approval, str) and approval else ""
        return f"A human reviewer declined this {name} call, so nothing was changed.{note}"

    selected = TOOLS_BY_NAME.get(name)
    if selected is None:
        return f"No tool named {name} exists. Available tools: {', '.join(TOOLS_BY_NAME)}."
    try:
        return json.dumps(selected.invoke(args), ensure_ascii=False)
    except Exception as error:  # noqa: BLE001 - the model should see this and adapt, not the loop die
        # A LookupError that lists the valid ids is how the model corrects itself.
        return f"{type(error).__name__}: {error}"
