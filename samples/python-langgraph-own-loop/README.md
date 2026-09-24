# Python + LangGraph — your agent loop, Cephable as the model

**The loop is yours. Cephable is the model inside it.**

The same support-triage job as [python-langchain-tools](../python-langchain-tools), turned inside out. There,
Cephable's own desktop agent runs the loop and calls back into your process for tools. Here, a LangGraph
graph you can read in one screen owns everything — the system prompt, the conversation, which tools run
and when, and a human approval gate — and Cephable is plugged in as `model="cephable-model"`, exactly where
you would otherwise put a hosted model.

| | [python-langchain-tools](../python-langchain-tools) | **this sample** |
|---|---|---|
| Who runs the loop | Cephable's desktop agent | a LangGraph `StateGraph` in [`agent.py`](agent.py) |
| Model id | `cephable-agent` | `cephable-model` |
| System prompt | Cephable's; yours is a preference | **yours**, used as-is |
| Conversation state | Cephable keeps it | **yours** — LangGraph's checkpointer, sent in full every call |
| Tools the model sees | Cephable's built-ins plus yours | **only yours** |
| Guardrails | `allowDestructiveTools`, per request | **your code** — here, an approval interrupt before a credit is issued |
| Best when | you want Cephable's file, browser and computer-use tools | the product, the tools and the rules are yours |

Everything runs on the machine. No prompt, order or customer record leaves the device.

---

## What you still get from Cephable

Pointing LangGraph at a raw llama.cpp server would also give you "a local model". What `cephable-model`
adds happens inside each model call, where your loop never sees it:

- **Long input just works.** A message or tool result too long for the on-device context window is saved
  on Cephable's side; the model sees its opening and reads the rest through Cephable's own summarize and
  generate tools, which chunk through all of it. Try `--attach` with a long document.
- **Long-form output isn't cut off.** When the answer is longer than one model turn can hold, the model
  writes it with Cephable's `generate_text` and it comes back as the reply, verbatim.
- **Tool calling tuned for the on-device model** — the same recovery Cephable's own agent relies on.

`--show-hidden` prints that work under each model call.

---

## Prerequisites

1. The Automate HTTP Server enabled in Cephable, and `CEPHABLE_AUTOMATE_KEY` exported. See
   [docs/getting-started.md](../../docs/getting-started.md). You need a Cephable desktop app new enough to list
   `cephable-model` in `GET /v1/models`; the sample checks and tells you if not.
2. **Python 3.10+.**

> **No Cephable licence yet?** Run the [fake server](../../tools/fake-cephable) with `--script own-loop` — this
> sample works against it end to end, streaming, parallel tool calls and approvals included. It is how the
> sample is tested.

---

## Run it

```bash
cd samples/python-langgraph-own-loop
python -m venv .venv
.venv\Scripts\activate          # Windows
source .venv/bin/activate       # macOS / Linux
pip install -r requirements.txt
python run_agent.py
```

It triages the email, stops to ask you before issuing a credit, streams the answer, then asks a follow-up
question on the same conversation:

```
Cephable at http://127.0.0.1:4317 · LangGraph owns the loop · model: cephable-model

  · model call: 2 messages (1 system, 1 user), 5 tools
  → lookup_order(order_id='4471')
  · model call: 4 messages (1 system, 1 user, 1 assistant, 1 tool), 5 tools
  → lookup_customer(email_or_id='C-1001')
  → get_policy(topic='late_shipment')
  · model call: 7 messages (1 system, 1 user, 2 assistant, 3 tool), 5 tools

  ⚠ approval needed: issue_credit — 15% of order 4471
    reason: Late shipment on a gold-tier account (late_shipment policy).
    approve? [y/N, or type a reason to decline] y

  → issue_credit(order_id='4471', percent=15, reason='Late shipment on a gold-tier account (late_shipment policy).')
  · model call: 9 messages (1 system, 1 user, 3 assistant, 4 tool), 5 tools

──────────────────────────────────────────────────────────────────────────────
SITUATION: Order 4471 is held because SW-200 is backordered, and it is past its promised date.
ACTION TAKEN: A 15% goodwill credit (CR-0001, 37.20 USD) was issued under the late_shipment policy.
ESCALATION: Yes — two prior complaints mean a named owner, not a queue.
DRAFT REPLY:
Hi Dana, ...
──────────────────────────────────────────────────────────────────────────────

You: Thanks. Now rewrite the draft reply as a formal letter I can post to her.
  · model call: 11 messages (1 system, 2 user, 4 assistant, 4 tool), 5 tools
…
```

Watch the `model call` lines: the message count only ever grows, because the conversation lives in your
process and goes to Cephable in full every time. The second turn works because *you* sent the first one.

Other things to try:

```bash
python run_agent.py --chat                         # keep talking to it
python run_agent.py --attach path/to/long.md \
  --prompt "Using the attached handbook, what may we offer Dana for order 4471?"
python run_agent.py --show-hidden                  # what Cephable did inside each model call
python run_agent.py --yes                          # approve credits without asking (demos, CI)
python run_agent.py --no-stream                    # whole replies instead of a stream
```

Decline the credit (press Enter, or type a reason) and the model is told a human said no — the credit never
runs, and the answer says so.

Run the tests any time — no Cephable, no network:

```bash
python -m unittest test_sample -v      # 11 tests; the 5 loop tests skip if LangGraph is not installed
```

The loop tests drive the real graph — real `ChatOpenAI`, real HTTP, real streaming — against the fake server
started in-process, and check what actually went over the wire: `cephable-model` on every call, your
system prompt first, the whole history each time, and both answers to a parallel pair sent back together.

---

## Demo script

Five minutes, for someone who has seen the other LangChain sample — or any LangGraph app.

1. **Open `agent.py` first.** "This is an ordinary LangGraph agent: a system prompt, five tools, an agent
   node, a tools node, one conditional edge. The only line that mentions Cephable is `model=\"cephable-model\"`."
2. **Run `python run_agent.py`.** Narrate the `model call` lines — the history growing — and the parallel
   `lookup_customer` + `get_policy` pair arriving in one turn.
3. **Stop at the approval.** "The model decided to issue a credit. My loop won't run it without me. That rule
   is in my code, not in a prompt." Approve it.
4. **The follow-up.** "Cephable remembers nothing. It knows what we talked about because LangGraph sent it
   the conversation — the same as calling any hosted model."
5. **Turn off Wi-Fi and run it again.** It still works. The model is on this laptop.
6. **Finish with `--attach`** on a document far bigger than a small model's context window, and
   `--show-hidden` to show Cephable reading it through its content tools while the loop sees one call.

Have ready: a terminal with the venv activated and `CEPHABLE_AUTOMATE_KEY` set.

---

## How it works

```
run_agent.py ── CLI: streaming, approvals, follow-up turns
     │
agent.py ── LangGraph StateGraph (MemorySaver checkpointer)
     │        START ─▶ agent ──tool calls?──▶ tools ──▶ agent … ─▶ END
     │                   │                      └─ interrupt() before issue_credit
     │                   │
     │     ChatOpenAI(model="cephable-model", base_url=<cephable>/v1).bind_tools(TOOLS)
     ▼
POST /v1/chat/completions ──▶ Cephable (model mode) ──▶ local llama.cpp
                               └ hidden: content refs, generate_text, summarize_text
```

| File | What it is |
|---|---|
| **`agent.py`** | The whole agent: system prompt, `@tool` wrappers, the model, and the graph. Read this first. |
| **`run_agent.py`** | The CLI: streams tokens from the agent node, turns LangGraph interrupts into an approve/decline prompt, runs follow-up turns, and logs each model call (httpx hooks — LangChain untouched). |
| **`tools.py`** | The domain functions over `data/store.json`, plus `issue_credit`, the one with a side effect. **Replace this with your own system.** |
| **`cephable_endpoint.py`** | The only Cephable-specific code: find the port, and check the app offers `cephable-model`. |
| **`console.py`** | Unicode output that survives a Windows terminal. |
| **`test_sample.py`** | Domain tests, loop tests against the fake server, and endpoint tests. |

### Four things worth copying

**Put the rules in the loop, not the prompt.** The prompt *asks* the model to wait for approval; the tools
node *enforces* it. `interrupt()` pauses the graph, the CLI asks a human, and `Command(resume=…)` carries the
answer back in. A model that ignores the prompt still cannot issue a credit.

**Ask before running anything.** When a turn mixes reads and a gated write, the tools node collects every
approval first and only then executes. A LangGraph interrupt re-runs the node from the top on resume, so
executing the reads first would run them twice.

**Treat Cephable as stateless.** Model mode keeps nothing between calls. The checkpointer is your memory; a
new `thread_id` is a new conversation. There is no `continuation` flag to manage.

**No retries, long timeouts, stream.** `max_retries=0` because there is one inference slot on the device and
a retry just collides with the request it is retrying. Streaming gets response headers back immediately
and a keep-alive every ten seconds, so long turns never trip an idle timeout. Ctrl+C closes the connection,
and Cephable cancels a call whose client has gone.

### Or use LangChain's prebuilt agent

`langchain.agents.create_agent(model, TOOLS, system_prompt=SYSTEM_PROMPT)` (LangChain 1.x — it replaces
LangGraph's deprecated `create_react_agent`) gives you a loop in one line, and works against
`cephable-model` unchanged. But it runs `issue_credit` the moment the model asks. This sample spells the
graph out so the approval gate and the tool execution are in plain view; with the prebuilt agent you would
add the gate as middleware.

---

## What this does not do

- **No Cephable tools.** The model sees your five tools and nothing else — no files, browser, email or app
  automation. If you want those, you want Cephable's own agent: [python-langchain-tools](../python-langchain-tools).
- **No persistence.** The conversation lives in LangGraph's in-memory `MemorySaver` and credits in a Python
  list; both vanish when the script exits. Swap in a durable checkpointer (SQLite, Postgres) for real use.
- **No concurrency.** One conversation, one request at a time — there is one inference slot on the device.
  A multi-user app has to queue on its side.
- **The approval gate is a terminal prompt**, not an audit trail. A real one would record who approved what.
- **No token-by-token streaming from inside a model call.** Cephable streams the finished answer in chunks;
  while its hidden loop works, the stream only carries keep-alives.
- **The fake server does not reason.** Its answers are fixed, so a declined credit still reads as issued
  against it. Only a real Cephable shows the model adapting.

---

## Troubleshooting

| | |
|---|---|
| `This Cephable does not offer 'cephable-model'` | The desktop app predates model mode. Update Cephable. |
| `No Cephable Automate server answered on 127.0.0.1:4317-4328` | Cephable is not running, the extension is off, or it moved outside the window. Check the extension detail view. |
| `409` / "already busy" | One inference slot, shared with the app's own panel and any other integration. Wait for it to finish. |
| `401` | The key was regenerated, or has a trailing newline. Copy it again. |
| The model answers without calling tools | Tighten the tool docstrings — say what each returns and when to call it. |
| Declined credits show as "issued" against the fake | The fake server's answers are fixed strings; a real model reads the declined result. |

More in [docs/getting-started.md](../../docs/getting-started.md).
