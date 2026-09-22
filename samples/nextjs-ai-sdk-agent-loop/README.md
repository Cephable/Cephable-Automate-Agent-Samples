# Next.js + Vercel AI SDK — the agent loop

**The AI SDK owns the loop. Cephable is the model behind it. The tools and the approval policy
are yours.**

This is the companion to [nextjs-vercel-ai-ui](../nextjs-vercel-ai-ui), and it is the opposite
arrangement:

| | [nextjs-vercel-ai-ui](../nextjs-vercel-ai-ui) | **this sample** |
|---|---|---|
| Who runs the loop | Cephable | `ToolLoopAgent` in your route handler |
| Whose tools run | Cephable's 46 built-ins, plus yours | only yours |
| What Cephable is | the whole agent | the reasoning model inside your agent |
| Best when | you want the desktop agent's file, browser and computer-use tools | the tools and the guardrails belong to your product |

Pick this shape when your app already knows what it is allowed to do, and you want an on-device
model to decide *when*.

---

## What it does

Ask it *"why is A-1043 late, and refund it if it's our fault?"* and:

1. `ToolLoopAgent` sends the question to Cephable.
2. Cephable asks for `lookup_order`. **Your** Next.js server executes it against
   [`data/orders.json`](data/orders.json) and hands the result back.
3. Cephable asks for `issue_refund`. That tool is declared `needsApproval: true`, so the loop
   **suspends** and the browser shows Approve / Reject.
4. Nothing moves until a human answers. On approve, the tool executes and the loop finishes.

Cephable never sees the order book. It sees a tool name, a JSON Schema, and whatever the
`execute` function chooses to return.

---

## Run it

```bash
npm install
cp .env.example .env.local     # paste your access key
npm run dev                    # http://localhost:3000
```

**Against the fake server**, with no Cephable install at all:

```bash
python ../../tools/fake-cephable/fake_cephable.py --script refund --port 4319
```

```bash
CEPHABLE_ENDPOINT=http://127.0.0.1:4319 \
CEPHABLE_AUTOMATE_KEY=fake-token-with-at-least-24-characters \
npm run dev
```

The `refund` script drives exactly the two tools this sample declares, so you can watch the
approval gate work before installing anything.

---

## The three things worth reading

### 1. Cephable is just a provider

[`lib/cephable.ts`](lib/cephable.ts). The Automate server speaks OpenAI's
`POST /v1/chat/completions`, so it drops into `@ai-sdk/openai-compatible` with a base URL and a
key. It also sweeps ports 4317–4328, because Cephable moves up the range when its preferred port
is taken and hardcoding 4317 breaks the moment a second instance is running.

**One wrinkle worth knowing about.** Cephable's route is deliberately *non-streaming* — a run is
a whole agent execution, not a token feed, so it answers once with the finished result. The AI
SDK's UI stream helpers call `agent.stream()`, which against a non-streaming model fails with
`Response stream ended without a finish reason`. The fix ships with the SDK:

```ts
wrapLanguageModel({ model: cephable('cephable-agent'), middleware: simulateStreamingMiddleware() })
```

That presents the single response as a one-chunk stream. The loop, the UI parts and the approval
flow all behave normally; the text simply arrives at once instead of typing itself out.

### 2. The loop is eight lines

[`app/api/agent/route.ts`](app/api/agent/route.ts):

```ts
const agent = new ToolLoopAgent({
    model,
    tools,
    instructions: '…',
    stopWhen: stepCountIs(8),
});

return createAgentUIStreamResponse({ agent, uiMessages: messages });
```

`stopWhen` is not optional in spirit. Without a stop condition a tool loop runs until the context
window gives out; eight steps is comfortably more than this task needs and still bounded.

### 3. Approval is a real gate, not a dialog

[`lib/tools.ts`](lib/tools.ts) marks one tool:

```ts
issue_refund: tool({
    description: 'Refund an order in full. This moves money and cannot be undone from here.',
    inputSchema: z.object({ orderId: z.string(), reason: z.string() }),
    needsApproval: true,
    execute: async ({ orderId, reason }) => { … },
}),
```

The server stops *before* executing and emits a `tool-approval-request`. [`components/Agent.tsx`](components/Agent.tsx)
renders it and answers with `addToolApprovalResponse({ id, approved })`. The run is genuinely
suspended in between — this is the same idea as Cephable's own destructive-tool gate
(`delete_path`, `run_command`, `move_path`), except here the policy is yours and applies to your
tools.

Here is the actual wire output from the run above, against the fake server:

```
data: {"type":"tool-input-available","toolName":"lookup_order","input":{"orderId":"A-1043"}}
data: {"type":"tool-output-available","output":{"found":true,"order":{…,"total":1840,…}}}
data: {"type":"tool-approval-request","approvalId":"aitxt-…","toolCallId":"call_tok-1.client_tool_r2"}
data: {"type":"finish","finishReason":"tool-calls"}
```

---

## A note on `HarnessAgent` and ACP

AI SDK 7 also ships `HarnessAgent`, which runs established *coding-agent harnesses* — Claude
Code, Codex, Pi — with their own sandboxes and permission flows. It is not the right abstraction
here: Cephable is a model plus an agent behind an OpenAI-compatible endpoint, not a harness to be
driven, so `ToolLoopAgent` is the correct fit. If you want Cephable's own agent loop instead of
the SDK's, that is the [nextjs-vercel-ai-ui](../nextjs-vercel-ai-ui) sample or the native
`/v1/runs` park/resume loop shown in [python-langchain-tools](../python-langchain-tools).

ACP (the Agent Client Protocol) is a separate editor↔agent protocol and is not part of the AI
SDK; nothing in this repo speaks it today.

---

## Security

The access key is **as powerful as the user**. It is read server-side only and must never get a
`NEXT_PUBLIC_` name — anything public is compiled into the browser bundle. The browser talks to
`/api/agent`; only the route handler talks to Cephable. That is also a practical necessity: the
Automate server sends no CORS headers and has no `OPTIONS` handler, so a `fetch` from a page
origin fails preflight.

This sample never sets `allowDestructiveTools` and declares no inline MCP servers. It does not
need Cephable's built-in tools at all — the model only ever sees the three tools defined here.
