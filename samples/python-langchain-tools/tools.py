"""
The sample's domain tools — the part you would replace with your own system.

Four plain Python functions over a small JSON store, plus the JSON Schema declarations Cephable needs
to offer them to the agent. Nothing here knows about Cephable or LangChain, which is the point: these
are the functions you already have.

Both entry points use this module:

* `run_native.py` passes `CLIENT_TOOL_SCHEMAS` as `clientTools` and `HANDLERS` to the park/resume loop.
* `run_langchain.py` wraps the same functions with LangChain's `@tool` decorator.

Two things worth copying into your own tools:

* **Descriptions are the whole interface.** They are the model's only guidance, and a sharp description
  does more for reliability than any amount of prompt engineering. Say what the tool returns, not just
  what it does.
* **Raise on a genuine failure.** Both entry points turn an exception into a tool error the agent sees,
  so it can adapt or explain. Returning `"not found"` as a success teaches it to keep guessing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

_STORE_PATH = Path(__file__).parent / "data" / "store.json"


def _store() -> Dict[str, Any]:
    with _STORE_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


# ── the tools ────────────────────────────────────────────────────────────────────────────────────


def lookup_order(order_id: str) -> Dict[str, Any]:
    """Fetch one order with its items, status, dates and carrier."""
    store = _store()
    order = next((o for o in store["orders"] if o["id"] == str(order_id).strip()), None)
    if order is None:
        known = ", ".join(o["id"] for o in store["orders"])
        raise LookupError(f"No order {order_id}. Known order ids: {known}")

    customer = next((c for c in store["customers"] if c["id"] == order["customerId"]), None)
    return {
        **order,
        "customerName": customer["name"] if customer else None,
        "customerTier": customer["tier"] if customer else None,
        # Derived, because "is it late" is the question actually being asked and we should not make a
        # small model do date arithmetic it can get wrong.
        "isLate": order["status"] in {"delayed", "processing"} and order["shippedAt"] is None,
    }


def lookup_customer(email_or_id: str) -> Dict[str, Any]:
    """Fetch one customer by email or id, with tier, tenure and prior complaint count."""
    needle = str(email_or_id).strip().lower()
    store = _store()
    customer = next(
        (c for c in store["customers"] if c["id"].lower() == needle or c["email"].lower() == needle),
        None,
    )
    if customer is None:
        raise LookupError(f"No customer matching {email_or_id!r} by id or email.")

    orders = [o for o in store["orders"] if o["customerId"] == customer["id"]]
    return {
        **customer,
        "orderCount": len(orders),
        "orderIds": [o["id"] for o in orders],
        "lifetimeValue": round(sum(o["total"] for o in orders), 2),
        # Surfaced as a flag rather than left implicit in priorComplaints, so the escalation policy is
        # something the agent can act on without inferring the threshold.
        "needsNamedOwner": customer["priorComplaints"] >= 2,
    }


def check_inventory(sku: str) -> Dict[str, Any]:
    """Check stock for one SKU: quantity on hand, whether it is backordered, and any restock date."""
    needle = str(sku).strip().upper()
    store = _store()
    item = next((i for i in store["inventory"] if i["sku"].upper() == needle), None)
    if item is None:
        known = ", ".join(i["sku"] for i in store["inventory"])
        raise LookupError(f"No SKU {sku}. Known SKUs: {known}")
    return item


def get_policy(topic: str) -> Dict[str, str]:
    """Look up the company's written policy on a topic, to quote rather than improvise."""
    needle = str(topic).strip().lower().replace(" ", "_").replace("-", "_")
    policies = _store()["policies"]
    if needle not in policies:
        raise LookupError(f"No policy named {topic!r}. Available topics: {', '.join(policies)}")
    return {"topic": needle, "policy": policies[needle]}


# ── what Cephable needs to offer them ────────────────────────────────────────────────────────────

HANDLERS = {
    "lookup_order": lookup_order,
    "lookup_customer": lookup_customer,
    "check_inventory": check_inventory,
    "get_policy": get_policy,
}

#: Passed straight through as `clientTools`. Cephable hands `parameters` to the agent verbatim — it
#: accepts JSON Schema directly — so `enum`, `required` and per-field descriptions all reach the model.
CLIENT_TOOL_SCHEMAS: List[Dict[str, Any]] = [
    {
        "name": "lookup_order",
        "description": (
            "Fetch one order by its id. Returns status, promised and shipped dates, carrier, tracking, "
            "line items with SKUs, the customer's name and tier, and an isLate flag. "
            "Use this before saying anything about an order's state."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "order_id": {"type": "string", "description": "The order id, e.g. '4471'"},
            },
            "required": ["order_id"],
        },
    },
    {
        "name": "lookup_customer",
        "description": (
            "Fetch one customer by email address or customer id. Returns tier, how long they have been "
            "a customer, prior complaint count, their order ids, lifetime value, and a needsNamedOwner "
            "flag that is true when policy requires a named human owner rather than a queue."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "email_or_id": {
                    "type": "string",
                    "description": "Email address or customer id, e.g. 'dana.whitfield@example.com' or 'C-1001'",
                },
            },
            "required": ["email_or_id"],
        },
    },
    {
        "name": "check_inventory",
        "description": (
            "Check stock for one SKU. Returns quantity on hand, whether it is backordered, and the "
            "restock date if there is one. Call this before promising any delivery date."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "sku": {"type": "string", "description": "The SKU, e.g. 'SW-200'"},
            },
            "required": ["sku"],
        },
    },
    {
        "name": "get_policy",
        "description": (
            "Look up the company's written policy on a topic so you can apply it exactly instead of "
            "guessing. Always call this before offering a refund, credit, or escalation."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "topic": {
                    "type": "string",
                    "enum": ["late_shipment", "backorder", "refund_window", "escalation"],
                    "description": "Which policy to read",
                },
            },
            "required": ["topic"],
        },
    },
]


def openai_tool_schemas() -> List[Dict[str, Any]]:
    """The same declarations in OpenAI `tools` shape, for any client that speaks that instead."""
    return [{"type": "function", "function": schema} for schema in CLIENT_TOOL_SCHEMAS]
