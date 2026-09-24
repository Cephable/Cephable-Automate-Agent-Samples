# Fake Cephable server

A stand-in for the Cephable Automate HTTP Server. Speaks enough of the real contract to run every sample
in this repo end to end **without the Cephable desktop app**.

It does not run a model. The "agent" is a fixed script that calls a couple of your tools and then
answers. What it gives you is the *protocol*: auth, port discovery, the park/resume loop, the OpenAI
tool-calling shape, and the error cases.

Useful for three things:

- **Developing a sample** without burning a real agent run on every edit.
- **CI**, which has no Cephable and no GPU.
- **Trying a sample before you have a Professional licence**, to see the shape of an integration.

---

## Run it

```bash
python tools/fake-cephable/fake_cephable.py                      # 127.0.0.1:4319
python tools/fake-cephable/fake_cephable.py --script incidents
python tools/fake-cephable/fake_cephable.py --scenario fail
python tools/fake-cephable/fake_cephable.py --port 4400
```

Python 3.10+, standard library only.

Then point a sample at it:

```bash
export CEPHABLE_ENDPOINT=http://127.0.0.1:4319
export CEPHABLE_AUTOMATE_KEY=fake-token-with-at-least-24-characters
```

> It listens on **4319**, not 4317, so a real Cephable keeps working and the samples' port sweep still
> finds the real one first. You must pin `CEPHABLE_ENDPOINT` to use the fake.

---

## Scripts

Each sample declares different tools, so a script that calls tools the caller does not have only ever
exercises the error path. Pick the one matching the sample you are running:

| `--script` | For | The fake agent calls |
|---|---|---|
| `support` *(default)* | [python-langchain-tools](../../samples/python-langchain-tools) | `lookup_order`, `get_policy` |
| `incidents` | [nextjs-vercel-ai-ui](../../samples/nextjs-vercel-ai-ui) | `list_incidents`, `get_incident`, `render_timeline`, `draft_status_post` |
| `refund` | [nextjs-ai-sdk-agent-loop](../../samples/nextjs-ai-sdk-agent-loop) | `lookup_order`, `issue_refund` (the second is gated behind approval in that sample) |
| `own-loop` | [python-langgraph-own-loop](../../samples/python-langgraph-own-loop) | `lookup_order`; then `lookup_customer` + `get_policy` together; then `issue_credit`. Answers a second user turn with a follow-up reply |
| `plain` | anything | nothing — answers immediately |

The [public-gateway](../../samples/public-gateway) sample works with any script; its own tests use an
in-process stub instead.

`--scenario fail` makes every run come back as a failed record under `HTTP 500`, which is the case
clients most often get wrong — see below.

---

## What it reproduces faithfully

These are the behaviours a client has to get right, so the fake is strict about them:

- **Bearer auth on every route**, `/health` included, returning `401` *before* routing — so an
  unauthenticated caller cannot discover which paths exist.
- **`service: "cephable-agent"` on `/health`**, so port discovery can tell Cephable apart from
  something else on the same port. (OpenTelemetry collectors also default to 4317.)
- **The park/resume loop**: `/v1/runs` → `awaiting_tool_results` + `resumeToken` →
  `/v1/runs/{token}/tool-results` → repeat or finish. A wrong or stale token gets `404`.
- **OpenAI tool-calling**: `tools` in, `finish_reason: "tool_calls"` out, the resume token folded into
  each `tool_call.id`, and a resume recognised from echoed `role: "tool"` messages.
- **A failed run as `HTTP 500` carrying a complete record** with `schemaVersion: 1`. This is the one
  clients get wrong most: a 500 here is not a server fault, and `schemaVersion` — not the status code —
  is what tells you whether a run happened.
- **`409` while a run is in flight**, and the `busy` / `awaitingToolResults` flags on `/health`.
- **Model mode** (`model: "cephable-model"`, or `cephable.mode: "model"`): stateless, like the real thing —
  the next step is worked out from the conversation you send (tool rounds answered since the last user
  message; a user turn after an earlier answer is a follow-up). Parallel tool calls come back in one
  `tool_calls` array, and there is no `cephable` record unless you pass `cephable.include`.
- **`stream: true` on chat completions**: a role chunk, a `: keep-alive` comment, content (or a
  `delta.tool_calls` chunk), the `finish_reason` chunk, an optional usage chunk, then `data: [DONE]`.
- **`400` on the validation failures clients actually hit**: an empty prompt, a non-array `results`, a
  result missing its `id`, a chat completion with no string user message.

It also logs what it received — declared tools, `restrictToWorkspace`, `allowDestructiveTools`,
`thinkingLevel`, whether an `answerContract` was set — so you can confirm your request was shaped
correctly:

```
[fake] /v1/runs  prompt='A customer has emailed about order 4471 asking why it has not…'
[fake]           clientTools=['lookup_order', 'lookup_customer', 'check_inventory', 'get_policy'] mcpServers=[]
[fake]           restrictToWorkspace=True allowDestructiveTools=False thinkingLevel=medium answerContract=yes
[fake] resume tok-0 with 1 result(s): [('client_tool_c1', 'result')]
```

---

## What it does not do

It is a protocol fake, not an emulator:

- **No model.** The answer is a fixed string and the tool calls are a fixed script. It cannot tell you
  whether your tool *descriptions* are good enough for a real model to use — only a real run can.
- **No Cephable tools.** No files, no web search, no email, no app automation.
- **No `restrictToWorkspace` enforcement**, no AI Skills, no MCP connections. It logs those fields but
  ignores them.
- **Looser validation** than the real server on most fields.

So: use it to get your client's plumbing right, then run against real Cephable before you believe
anything about quality or latency.

## Using it from tests

Import it and serve it in-process — `python-langgraph-own-loop/test_sample.py` does this:

```python
import fake_cephable
fake_cephable.use_script("own-loop")
server = fake_cephable.serve(0)            # any free port
threading.Thread(target=server.serve_forever, daemon=True).start()
# … point your client at server.server_address, then inspect fake_cephable.RECEIVED
```

`RECEIVED` holds every chat-completions body the fake has seen, so a test can assert what went over the wire.
