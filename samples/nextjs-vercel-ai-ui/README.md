# Next.js + Vercel AI SDK

A chat UI built with the **Vercel AI SDK**, driving Cephable's on-device agent and streaming its **real
tool calls and steps** into the browser as they happen.

The scenario is an incident review. The agent's tools are this app's own functions — and two of them
don't return data to the agent at all, they *draw into the page*: `render_timeline` puts a timeline on
screen, `draft_status_post` puts a copyable draft on screen. That is what makes an agent feel like part
of an app rather than a text box bolted onto one.

---

## What this shows

- **The AI SDK's UI primitives over a non-streaming agent.** Cephable's `/v1/runs` blocks until the run
  finishes — it has no token stream. But the park/resume loop *is* a real sequence of events, so the
  route writes each one into a `UIMessageStream` as it lands. The UI fills in as the agent works,
  without pretending to stream tokens that do not exist.
- **Typed custom data parts.** Tool calls, tool results, timelines, drafts, the step list and the run
  footer all arrive as `data-*` parts on the assistant message. Rendering is a switch over `part.type`.
- **Tools whose output is UI.** A tool returns a short confirmation to the agent and pushes its real
  payload to the browser. The agent does not have to re-read what it just drew.
- **Why the route handler is the client.** The Automate server sends no CORS headers and has no
  `OPTIONS` handler, so a browser page *cannot* call it. That is not a limitation to work around — it is
  the correct architecture, and it keeps the access key out of the browser bundle.
- **Honest run metadata.** Which local GGUF served the run, which GPU accelerator, whether it fell back
  to CPU, tokens, wall-clock time. A cloud model cannot tell you any of that.

---

## Prerequisites

1. The Automate HTTP Server enabled in Cephable — see [docs/getting-started.md](../../docs/getting-started.md).
2. **Node 20+**.

```bash
cd samples/nextjs-vercel-ai-ui
npm install
cp .env.example .env.local     # then paste your key into it
npm run dev
```

Open <http://localhost:3000>.

> **No Cephable licence yet?** Run the [fake server](../../tools/fake-cephable) with the matching script
> and point `.env.local` at it — this is exactly how the sample is tested:
>
> ```bash
> python ../../tools/fake-cephable/fake_cephable.py --script incidents
> # .env.local:
> #   CEPHABLE_AUTOMATE_KEY=fake-token-with-at-least-24-characters
> #   CEPHABLE_ENDPOINT=http://127.0.0.1:4319
> ```

---

## What a run looks like

Click a suggested prompt, or ask your own. Each tool call appears the moment the run parks on it:

```
YOU        Compare INC-204 and INC-207 on a timeline and tell me if they share a root cause.

CEPHABLE   [on-device]  gemma-4-4b-it-Q4_K_M.gguf   vulkan   16,384 ctx

           list_incidents (openOnly: true)
           ✓ 2 result(s)

           get_incident (id: "INC-204")
           ✓ id, title, severity, service, openedAt, …

           render_timeline (incident_ids: ["INC-204","INC-207"])
           ┌─ TIMELINE ─────────────────────────────────────────────┐
           │ 2026-09-14 09:04Z  INC-207 · Payments worker backlog   │
           │                    payments-worker · sev2 · resolved   │
           │ 2026-09-14 09:12Z  INC-204 · Checkout API 503s         │
           │                    checkout-api · sev1 · resolved      │
           └────────────────────────────────────────────────────────┘
           ✓ Rendered a timeline of 2 incident(s) in the user's browser.

           draft_status_post (title: "Checkout delays on 14 September", …)
           ┌─ Checkout delays on 14 September ──────────── [Copy] ──┐
           │ Between 09:04 and 12:20 UTC some checkouts failed…     │
           └────────────────────────────────────────────────────────┘

           INC-204 and INC-207 share a root cause: the 09:00 deploy doubled outbound
           concurrency from payments-worker without raising the checkout-api pool
           ceiling, so the backlog and the 503s are two symptoms of one change.

           ▸ 5 agent steps        completed · 37.0s · 344 tokens out · 41.2 tok/s
```

---

## Demo script

Four minutes.

1. **Open the app.** "Ordinary Next.js, ordinary Vercel AI SDK chat. The model is running on this
   laptop."
2. **Click "What is still broken right now…"** and narrate the tool calls as they appear: *"it's
   querying our incident data — that's our function, running in our server, not a model guessing."*
3. **Then click the comparison prompt.** When the timeline draws itself, stop and point at it: **"the
   agent decided a timeline was the right way to answer, and drew it. That's not a canned widget — it
   picked the tool and picked the two incidents."** This is the moment.
4. **Then the draft.** It appears with a Copy button. "Same mechanism. The agent's output is UI, not
   just prose."
5. **Open the run footer.** Read the model name and accelerator. "That's the GGUF on this machine and
   the GPU it used. No API key, no tenant, no egress."
6. **Turn off Wi-Fi and do it again.** It still works.

Have ready: `npm run dev` already warm (the first run pays a model load), Cephable's AI Workflows panel
visible so they can see the same run appear there, and the incident data open in an editor to show the
tools are reading real records.

---

## How it works

```
browser                   Next.js server                     Cephable (127.0.0.1)
───────                   ──────────────                     ────────────────────
useChat ──POST /api/chat──▶ waitUntilReady()  ───────────────▶ GET /health
                            startRun(clientTools) ───────────▶ POST /v1/runs
                          ◀─ writes data-run-started
                                                    ◀───────── status: awaiting_tool_results
                          ◀─ writes data-tool-call             (the run parks, still holding the slot)
                            handlerFor(name)(args)
                          ◀─ writes data-timeline / data-draft
                          ◀─ writes data-tool-result
                            resumeRun(token, results) ───────▶ POST /v1/runs/{token}/tool-results
                                                    ◀───────── …repeat, or the finished record
                          ◀─ writes text-start/delta/end
                          ◀─ writes data-steps, data-run-finished
```

| File | What it is |
|---|---|
| **`app/api/chat/route.ts`** | **The interesting file.** The park/resume loop, written into a `UIMessageStream`. Also where the `data-*` part types are declared. |
| **`lib/tools.ts`** | This app's tools: three reads and two that emit UI. Replace with your own. |
| `lib/cephable.ts` | Server-side client: port discovery, readiness, runs, resume, cancel. |
| `components/Chat.tsx` | `useChat` plus a switch over `part.type`. |
| `data/incidents.json` | Demo data. Two incidents share a root cause on purpose, and one service is deliberately over budget, so there is something to actually notice. |

### Three things worth copying

**A tool can have a UI side effect.** `render_timeline` takes an `emit` callback, queues an effect, and
returns a one-line confirmation. The route drains the queue into `data-*` parts. The agent's context
stays small; the browser gets the payload.

```ts
render_timeline: ({ incident_ids }, context) => {
    const selected = /* … */;
    context.emit({ kind: 'timeline', incidents: selected });
    return `Rendered a timeline of ${selected.length} incident(s) in the user's browser.`;
}
```

**Gate on readiness, don't retry into a 409.** One inference slot, shared with whoever is using the
Cephable app. `waitUntilReady()` waits politely; the error path explains *why* rather than saying
"failed".

**Cancel on your error path.** If the route throws or the client disconnects, the run keeps going inside
Cephable and holds the slot. The route calls `cancelRun(true)` before giving up. The loop also has a
`MAX_TOOL_ROUNDS` seatbelt, because a model looping on one tool would hold the machine all day.

### What this sample does *not* do

**Browser-executed tools.** Every tool here runs in the Next.js server. Running one in the *browser* —
so the agent could read the user's selection or manipulate the DOM — is possible, but it needs run state
to survive across HTTP requests: the route would have to end the stream, hold the parked Cephable run
keyed by chat id, wait for the client's tool result on a second request, and resume. The AI SDK supports
the client half of that (`onToolCall` + `addToolResult`); the server half is real work and would bury
what this sample is trying to show. Worth its own sample.

**`continuation`.** Every prompt is self-contained. Cephable's conversation state is shared with the
app's own panel, so a continuation can pick up a conversation the person at the machine was having.

**Streaming tokens.** There is no token stream to forward. What streams is the sequence of real events.

---

## Troubleshooting

| | |
|---|---|
| "No Cephable server answered on 127.0.0.1:4317-4328" | Cephable is not running, or the extension is off. Check its detail view says **Running**. |
| "Cephable is busy with another run" | One inference slot, shared with the app's panel. Wait, or stop the run in Cephable. |
| Every tool result says "no such tool" | Your stub is running a script for a different sample. Use `--script incidents`. |
| The first run is very slow | Model load. Subsequent runs reuse the warm worker. |
| `cpuFallback` in the run header | GPU acceleration failed and it degraded to CPU — an order of magnitude slower. |
| Nothing appears at all | Check the terminal running `npm run dev`; route-handler errors surface there, and as a `data-notice` part in the UI. |
