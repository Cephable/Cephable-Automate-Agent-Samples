"""
The sample's domain tools — the part you would replace with your own system.

The same four read tools and the same `data/store.json` as the python-langchain-tools sample, so the two
are easy to compare, plus one tool that **changes** something: `issue_credit`. It exists to show the thing
you get from owning the agent loop — the loop in `agent.py` refuses to run it until a human says yes.

Nothing here knows about Cephable, LangChain or LangGraph. These are the functions you already have.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Dict, List

_STORE_PATH = Path(__file__).parent / "data" / "store.json"

#: Credits issued this session. In memory on purpose: a sample should not rewrite its own dataset.
CREDITS_ISSUED: List[Dict[str, Any]] = []
_CREDITS_LOCK = threading.Lock()

MAX_CREDIT_PERCENT = 25


def _store() -> Dict[str, Any]:
    with _STORE_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


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
        # Derived, because "is it late" is the question actually being asked and a small model should
        # not be doing date arithmetic it can get wrong.
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
        "needsNamedOwner": customer["priorComplaints"] >= 2,
    }


def check_inventory(sku: str) -> Dict[str, Any]:
    """Check stock for one SKU: quantity on hand, whether it is backordered, and any restock date."""
    needle = str(sku).strip().upper()
    item = next((i for i in _store()["inventory"] if i["sku"].upper() == needle), None)
    if item is None:
        known = ", ".join(i["sku"] for i in _store()["inventory"])
        raise LookupError(f"No SKU {sku}. Known SKUs: {known}")
    return item


def get_policy(topic: str) -> Dict[str, str]:
    """Look up the company's written policy on a topic, to quote rather than improvise."""
    needle = str(topic).strip().lower().replace(" ", "_").replace("-", "_")
    policies = _store()["policies"]
    if needle not in policies:
        raise LookupError(f"No policy named {topic!r}. Available topics: {', '.join(policies)}")
    return {"topic": needle, "policy": policies[needle]}


def issue_credit(order_id: str, percent: float, reason: str) -> Dict[str, Any]:
    """Credit a percentage of an order's total back to the customer. The one tool with a side effect."""
    order = lookup_order(order_id)
    if not 0 < float(percent) <= MAX_CREDIT_PERCENT:
        raise ValueError(f"percent must be between 0 and {MAX_CREDIT_PERCENT}; got {percent}")
    if not str(reason).strip():
        raise ValueError("reason is required, so the credit can be audited")

    with _CREDITS_LOCK:
        credit = {
            "creditId": f"CR-{len(CREDITS_ISSUED) + 1:04d}",
            "orderId": order["id"],
            "customerName": order["customerName"],
            "percent": float(percent),
            "amount": round(order["total"] * float(percent) / 100, 2),
            "currency": order["currency"],
            "reason": str(reason).strip(),
        }
        CREDITS_ISSUED.append(credit)
    return credit
