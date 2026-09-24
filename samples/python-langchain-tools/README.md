# Python + LangChain, with your own tools

A support-triage agent where **your Python functions are the tools**. The agent reads a customer's
order, checks stock, looks up the written policy, works out what the company is actually allowed to
offer, and drafts the reply — calling back into this process every time it needs a fact.

The same job is implemented twice, so you can see both integration styles side by side:

| | | |
|---|---|---|
| **`run_native.py`** | Cephable's native `/v1/runs` route | Standard library only. Nothing to install. |
| **`run_langchain.py`** | LangChain's `ChatOpenAI` + `bind_tools` | Zero Cephable-specific code in the agent loop. |

Both let **Cephable's** agent run the loop. To run the loop yourself with Cephable as just the model, see
[python-langgraph-own-loop](../python-langgraph-own-loop).

Everything runs on the machine. No prompt, no order, and no customer record leaves the device.

---

## What this shows

- **Your functions, as agent tools.** Four plain Python functions over a JSON store, declared by JSON
  Schema, executed in this process.
- **The park/resume loop.** When the agent calls one of your tools, the run *parks* — it stays alive
  and keeps its place in the agent loop — and Cephable hands you the call. You answer; it continues.
  You watch each call land in the terminal.
- **LangChain unchanged.** `ChatOpenAI(base_url=…).bind_tools([...])` works as-is, because Cephable
  answers `finish_reason: "tool_calls"` and folds its resume token into each `tool_call.id`.
- **An `answerContract`,** so the closing message has four fixed headings a program can parse instead
  of prose you have to read.
- **What a local agent can tell you that a cloud one cannot** — which GGUF served the run, which GPU
  accelerator, the real step list, tokens and wall-clock time.

---

## Prerequisites

1. The Automate HTTP Server enabled in Cephable, and `CEPHABLE_AUTOMATE_KEY` exported. See
   [docs/getting-started.md](../../docs/getting-started.md).
2. **Python 3.10+** (uses `X | None` annotations).

> **No Cephable licence yet?** Run the [fake server](../../tools/fake-cephable) instead — both scripts
> work against it end to end. It is how this sample is tested.

---

## Run it

```bash
cd samples/python-langchain-tools

# The native route: no dependencies at all
python run_native.py

# The LangChain route
python -m venv .venv
.venv\Scripts\activate          # Windows
source .venv/bin/activate       # macOS / Linux
pip install -r requirements.txt
python run_langchain.py
```

Both print the agent's tool calls as they happen, then its answer.

```
Cephable
  endpoint      http://127.0.0.1:4317
  app version   4.2.1  (win32/x64)
  model         gemma-4-4b-it-Q4_K_M.gguf
  accelerator   vulkan
  context       16384 tokens
  status        idle (busy=False)

Waiting for the assistant to be free…
Running. Tool calls will appear as the agent makes them:

  → agent called lookup_order(order_id='4471')
  → agent called lookup_customer(email_or_id='C-1001')
  → agent called check_inventory(sku='SW-200')
  → agent called get_policy(topic='late_shipment')

──────────────────────────────────────────────────────────────────────────────
SITUATION: Order 4471 is held because SW-200 is backordered, and it is four days past
its promised date of 2026-09-09.
ENTITLEMENT: Under late_shipment, Dana may take both a full shipping refund and a 15%
credit on the order total, because she is gold tier.
ESCALATION: Yes — two prior complaints means a named human owner, not a queue.
DRAFT REPLY:
Hi Dana, ...
──────────────────────────────────────────────────────────────────────────────

4 steps | 52.3s | 612 output tokens | 38.4 tok/s
```

Other things to try:

```bash
python run_native.py --order 4472          # a shipped order — different answer
python run_native.py --thinking high       # more reasoning budget
python run_native.py --raw                 # the full run record as JSON
python run_native.py --prompt "Priya Raman needs an invoice for her August order. What do we tell her?"
```

Run the tests any time — they need no Cephable, no network, and no LangChain:

```bash
python -m unittest test_sample -v      # 23 tests
```

---

## Demo script

Five minutes, for someone who has not seen this before.

1. **Set the frame.** "This is a support agent. The interesting part is that the tools it uses are our
   own functions, and the model is running on this laptop — nothing here touches a cloud API."
2. **Show the data, not the code.** Open `data/store.json`. Point at order 4471: held, backordered,
   past its promised date, and a customer with two prior complaints. "Four facts in three different
   places. A human has to join them up to answer this email correctly."
3. **Run `python run_native.py`.** Narrate the tool calls as they appear — *"there it is reading the
   order… now the customer… now checking whether the part is even in stock… now pulling the actual
   policy text."* This is the moment that lands: the agent is not guessing, it is asking your systems.
4. **Read the output.** The four headings. Point out that it declined to promise a delivery date,
   because `check_inventory` told it the part is backordered — and that it caught the escalation rule
   from the complaint count.
5. **Turn off the network.** Genuinely — disable Wi-Fi and run it again. It still works. "That is the
   whole pitch. This runs in a SCIF, on a plane, in a hospital, under a data-residency rule."
6. **Then show `run_langchain.py`.** "Same agent, same tools, but this is a stock LangChain app. Two
   lines changed: the base URL and the API key."

Have ready: a terminal with the venv already activated and `CEPHABLE_AUTOMATE_KEY` already set, and
Cephable's AI Workflows panel visible on screen — the run shows up there live, which makes the point
that this is the real assistant and not a side channel.

---

## How it works

```
run_native.py                          run_langchain.py
     │                                      │
     │ clientTools + park/resume            │ ChatOpenAI.bind_tools()
     ▼                                      ▼
cephable_client.py                     langchain-openai
     │                                      │
     └──────────► POST /v1/runs   POST /v1/chat/completions ◄──┘
                       Cephable desktop app
                            agent loop
                                 │
                    parks ───────┴─────── your handler runs here
```

| File | What it is |
|---|---|
| **`tools.py`** | The four domain functions, plus their JSON Schema declarations. **Replace this with your own system.** |
| **`data/store.json`** | A tiny fake dataset. Deliberately messy — a late order, a backordered part, a customer with a complaint history — so the agent has something real to reason about. |
| **`cephable_client.py`** | Dependency-free client: port discovery, readiness gating, the park/resume loop, run-vs-request error handling. Copy this into your own project. |
| **`console.py`** | Makes Unicode output survive a Windows terminal. See [the note below](#the-windows-console-thing). |
| **`run_native.py`** | Entry point for the native route. |
| **`run_langchain.py`** | Entry point for the LangChain route. |
| **`test_sample.py`** | 23 tests covering the tools, their schemas, and the park/resume loop against a fake transport. |

### The park/resume loop, concretely

```
POST /v1/runs   { prompt, clientTools: [lookup_order, …] }
  → 200 { status: "awaiting_tool_results",
          toolCalls: [{ id: "client_tool_5f2a…", name: "lookup_order", arguments: { id: "4471" } }],
          resumeToken: "b41e…" }

  …we run lookup_order("4471") right here in this process…

POST /v1/runs/b41e…/tool-results   { results: [{ id: "client_tool_5f2a…", result: {…} }] }
  → 200 { status: "awaiting_tool_results", … }     ← the agent wants another tool
  → 200 { status: "completed", answer: "…" }        ← done
```

`run_with_tools()` in `cephable_client.py` drives this to completion.

### Four things worth copying

**Descriptions are the interface.** They are the model's only guidance. Compare
`"Fetch an order"` with what `tools.py` actually says — what it returns, and when to call it. A sharp
description does more for reliability than any prompt engineering.

**Derive the question actually being asked.** `lookup_order` returns an `isLate` boolean and
`lookup_customer` returns `needsNamedOwner`, rather than making a small local model do date arithmetic
or remember a policy threshold. Put the judgement in your code where you can test it.

**Raise on real failures.** Both entry points turn an exception into a tool error the agent sees, so it
adapts or explains. Returning `"not found"` as a *success* teaches it to keep guessing. Notice that
`lookup_order` lists the valid ids in its error — the agent reads that and corrects itself.

**Cancel on your error path.** Your request dying cancels a run that is still working, but a run parked
on your tools keeps the single inference slot until it times out. `run_native.py` cancels on
`KeyboardInterrupt`, which covers both.

### Getting the run record out of LangChain

`langchain-openai` drops response fields it does not model, so Cephable's `cephable` record is **not**
in `AIMessage.response_metadata` — verified, only `token_usage`, `model_name`, `finish_reason` and
friends survive. `CephableRecordCapture` in `run_langchain.py` installs an `httpx` response hook
instead, which leaves the LangChain loop completely untouched.

### The Windows console thing

Python on Windows defaults stdout to the legacy ANSI code page, so printing `→` raises
`UnicodeEncodeError` and kills the script. That is a poor way to end a demo. `console.py` asks for
UTF-8 and falls back to ASCII glyphs when the terminal genuinely cannot do it. Worth stealing for any
CLI you intend to demo on Windows.

---

## Troubleshooting

| | |
|---|---|
| `No Cephable Automate server answered on 127.0.0.1:4317-4328` | Cephable is not running, the extension is off, or it moved outside the window. Check the extension detail view. |
| `409` / "busy with another run" | One inference slot, shared with the app's own panel. Wait, or `POST /v1/automate/cancel`. |
| `401` | The key was regenerated, or has a trailing newline. Copy it again. |
| The agent answers without calling tools | Its descriptions are not specific enough about *when* to call. Make them say what they return. |
| `LookupError` in the output | Working as intended — the agent asked for something that does not exist and was told so. Watch it correct itself. |
| The whole thing is slow | Check `accelerator` in the header. `cpuFallback` means GPU acceleration failed, which is an order of magnitude slower. |

More in [docs/getting-started.md](../../docs/getting-started.md#6-first-run-failures-in-order-of-likelihood).
