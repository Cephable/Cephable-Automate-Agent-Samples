# API cheatsheet

The whole Automate HTTP Server contract on one page. Full reference: [Cephable Developer Docs](https://developers.cephable.com/docs/automate-http-server/api-reference).

**Base URL** `http://127.0.0.1:4317` (sweeps to `4328`) · **Auth** `Authorization: Bearer <key>` on *every* route, `/health` included · **Bodies** JSON, max 1 MiB · **Streaming** opt-in with `stream: true` (SSE) · **No CORS**

---

## Endpoints

| Method | Path | Purpose | While busy |
|---|---|---|---|
| `GET` | `/health` | Readiness, runtime, device, workspace | ✅ |
| `GET` | `/v1/models` | OpenAI-shaped list: `cephable-agent` (assistant) and `cephable-model` (model mode) | ✅ |
| `GET` | `/v1/automate/models` | The on-device GGUF catalog | ✅ |
| `POST` | `/v1/automate/models/select` | Pin a model for this app session | ❌ `409` |
| `GET` | `/v1/automate/tools` | Built-in tool catalog and server policy | ✅ |
| `PUT` · `DELETE` | `/v1/automate/tools/policy` | Save or clear the server-wide tool policy | ✅ |
| `POST` | `/v1/automate/cancel` | Stop whatever is running | ✅ |
| `POST` | `/v1/runs` | Run a task (native) | ❌ `409` |
| `POST` | `/v1/runs/{resumeToken}/tool-results` | Resume a parked run | ✅ by design |
| `POST` | `/v1/chat/completions` | Run a task, or a model-mode turn (OpenAI) | ❌ `409`¹ |
| `GET` · `PATCH` | `/v1/settings` | Workspace folder, file scope, templates, server defaults | ✅ |
| `GET` · `POST` | `/v1/speech/status` · `/start` · `/stop` | Speech recognition state and control | ✅ |
| `GET` | `/v1/speech/stream` | Live commands and dictation (SSE) | ✅ |
| `POST` | `/v1/speech/transcribe` | Transcribe a WAV file | ✅ |
| `GET` · `PUT` | `/v1/audio/inputs` · `/v1/audio/input` | List and choose the microphone | ✅ |

¹ unless the body carries tool results for a parked run.

Anything else → `404`. A wrong method on a core route → also `404`; on settings and speech routes → `405`.

---

## Two modes

| `model` / `mode` | You get |
|---|---|
| `cephable-agent` / `"assistant"` (default) | Cephable's desktop agent does the task with its own tools and yours; latest user message is the task |
| `cephable-model` / `"model"` | A chat model for **your** agent loop: your system prompt, the full `messages` history every call, only your tools. Cephable's content handling for long input/output runs hidden underneath |

Both take `builtInTools: { allow, deny }` (tool names or `@content`, `@destructive`, `@observe`, … groups) to choose which of Cephable's tools may run.

---

## `POST /v1/runs` — request

```jsonc
{
  "prompt": "Read every .csv here and write results.md summarizing the totals.",  // required

  "taskId": "nightly-2026-09-17",        // your correlation id, echoed back
  "timeoutMs": 600000,                   // default 900000 (15 min), min 1000
  "thinkingLevel": "medium",             // low | medium | high | max
  "additionalWorkflowPrompt": "Use metric units.",   // advisory style preferences
  "answerContract": "End with FINAL ANSWER: <number>", // BINDING output shape
  "include": { "steps": true, "trace": false, "events": false },
  "mode": "assistant",                   // or "model" — then send "messages" instead of "prompt"
  "builtInTools": { "deny": ["@destructive"] },   // allow/deny Cephable's own tools
  "stream": false,                       // true → SSE: run.started, run.step, run.status, run.completed
  "restrictToWorkspace": true,           // default false — confine file/CLI tools
  "continuation": false,                 // continue the previous conversation
  "allowDestructiveTools": false,        // default false — see warning below
  "selectedSkillIds": ["expense-process"],
  "selectedMcpServerIds": ["internal-finance"],
  "hitlAnswers": { "recipient": "team@example.com" },

  "mcpServers": [ /* inline MCP servers — your tools, hosted by you */ ],
  "clientTools": [ /* caller-executed tools — your tools, run by you */ ]
}
```

### Response

```jsonc
{
  "schemaVersion": 1,                    // ← the "a run happened" signal
  "requestId": "automate-run-9c2e…",
  "taskId": "nightly-2026-09-17",
  "status": "completed",                 // completed|failed|canceled|terminated|awaiting_tool_results
  "answer": "…",                         // what a person would have read
  "finalAnswer": "…",                    // only when answerContract was set
  "errorCode": "TOOL_TIMEOUT",           // only when not completed
  "startedAt": "2026-09-17T18:02:11.004Z",
  "completedAt": "2026-09-17T18:02:48.771Z",
  "durationMs": 37767,                   // wall clock, incl. model load
  "model": "gemma-4-4b-it-Q4_K_M.gguf",  // GGUF file name
  "appVersion": "4.2.1",
  "backend": { "flavorId": "vulkan", "accelerator": "vulkan", "cpuFallback": false },
  "steps": [ /* ordered tool calls */ ],
  "trace": [ /* raw model messages */ ],
  "usage": { "inputTokens": 5120, "outputTokens": 344, "generationMs": 8345, "ttftMs": 610, "tps": 41.2 },
  "events": [ /* every channel event — LARGE */ ],

  "toolCalls": [ /* only when awaiting_tool_results */ ],
  "resumeToken": "b41e…"                 /* only when awaiting_tool_results */
}
```

### Status codes

| Code | Meaning |
|---|---|
| `200` | `completed`, or `awaiting_tool_results` (a parked run is a success) |
| `500` | The run ran and ended `failed` / `canceled` / `terminated` — **body is a full record**, `schemaVersion` is still `1` |
| `400` | Bad request, malformed JSON, unknown tool name, run timeout, init failure |
| `413` | Body > 1 MiB |
| `401` | Bad or missing key |
| `409` | A run is already active or preparing |

```javascript
// The only correct way to branch
if (body.schemaVersion === 1) {
    // a run happened — trust body.status, not the HTTP code
} else {
    // no run happened — body.error.message says why
}
```

---

## Custom tools

### Inline MCP servers (you host them)

```jsonc
"mcpServers": [{
  "name": "my-app",                      // lowercase/digits/hyphens; = mcp__my-app__* prefix
  "description": "Order lookup and customer records",   // drives relevance
  "transport": "http",                   // http | sse | stdio
  "url": "http://127.0.0.1:9123/mcp",
  "headers": { "Authorization": "Bearer internal" },
  "requireApproval": false,              // DEFAULT false here (configured servers default true)
  "disabledTools": ["debug_dump"]
}]
```

Max 8. A name that collides with a server the user has configured is a `400` — rename it.

⚠️ `transport: "stdio"` spawns a local process with your `command`/`args`/`env`, and is **not** gated by `allowDestructiveTools`. Treat it as arbitrary local execution.

### Caller-executed tools (you run them)

```jsonc
"clientTools": [{
  "name": "lookup_order",                // letters/digits/_/-; not "mcp__*"
  "description": "Fetch an order by its id. Returns status, items and ship date.",
  "parameters": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
}]
```

Max 32. `parameters` is passed to the agent verbatim, so your `enum`s and `required` reach the model intact.

**The loop:**

```
POST /v1/runs                     → 200 { status: "awaiting_tool_results", toolCalls, resumeToken }
   execute the calls yourself
POST /v1/runs/{resumeToken}/tool-results
   { "results": [{ "id": "<toolCalls[].id>", "result": "…" }] }
                                  → 200 { another awaiting_tool_results, OR the finished record }
   repeat until status !== "awaiting_tool_results"
```

Report failures rather than inventing results — the agent adapts:

```jsonc
{ "results": [{ "id": "…", "error": "the orders database is unreachable" }] }
```

**Parked-run rules:** it holds the single inference slot · **two minutes per round** or it self-cancels · `timeoutMs` is armed once at run start, not per round · `/health` shows `awaitingToolResults`.

---

## OpenAI route

```
Base URL  http://127.0.0.1:4317/v1     API key  your access key     Model  cephable-agent
```

| OpenAI field | Effect |
|---|---|
| last `role: "user"` message | becomes the prompt (string content only) |
| all `role: "system"` messages | joined → `additionalWorkflowPrompt` (advisory) |
| `tools` (`type: "function"`) | **→ `clientTools`.** Answers `finish_reason: "tool_calls"` |
| `role: "tool"` messages | resume the parked run the `tool_call_id`s belong to |
| `timeout_ms` | → `timeoutMs` |
| `cephable: { answerContract, include, continuation, thinkingLevel, mcpServers }` | the extension object |
| `model`, `stream`, `temperature`, `top_p`, `seed`, `max_tokens`, `n`, `stop`, `response_format`, `tool_choice`, `functions` | **ignored silently** |

Earlier `user`/`assistant` turns are **not** replayed — Cephable owns conversation state. Fold context into the last message, or use `cephable.continuation`.

The full native record comes back in the response's `cephable` field.

**With the SDKs:** set `maxRetries: 0` (a retry hits `409` or starts a duplicate run) and a very long timeout.

---

## Other endpoints

```jsonc
// GET /health — ready when busy:false and workflowStatus is idle|terminated
{ "status": "ok", "service": "cephable-agent", "workflowStatus": "idle", "busy": false,
  "awaitingToolResults": false, "modelName": "…gguf", "workspace": "…", "contextSize": 16384,
  "backend": { "accelerator": "vulkan", "cpuFallback": false }, "activeRequestId": null }

// GET /v1/automate/models — usable = supportsTools && availableForDevice && downloaded
{ "object": "list", "data": [{ "name": "Gemma 4 M", "family": "Gemma", "sizeCode": "M",
    "supportsTools": true, "availableForDevice": true, "downloaded": true, "selected": true }],
  "catalog": { "status": "ready", "modelCount": 7 } }

// POST /v1/automate/models/select — session pin; {} restores the app's own choice
{ "family": "Gemma", "sizeCode": "M" }        → { "selected": {...}, "models": [...] }

// POST /v1/automate/cancel — always safe, even when nothing is running
{ "force": false }   // false: unwind between steps, worker stays warm
                     // true:  kill the worker (always works, cold start next run)
                     → { "stopped": true, "mode": "cancel", "requestId": "…", "workflowStatus": "…" }
```

---

## Error codes (`errorCode` on a non-completed run)

| Code | Meaning |
|---|---|
| `MODEL_LOAD_FAILED` | The GGUF could not be loaded |
| `CONTEXT_LIMIT_EXCEEDED` | Outgrew `contextSize` — split the task, or drop `continuation` |
| `TOOL_TIMEOUT` | A tool call hung (often a web fetch or MCP server) |
| `PLANNING_TIMEOUT` | No plan formed — simplify, or raise `thinkingLevel` |
| `EXECUTION_TIMEOUT` / `EXECUTION_FAILED` | Read the last failed step's `toolArgs` and `resultSummary` |
| `SCHEMA_INVALID` | Malformed tool call from the model |
| `SERVER_LOST` | llama.cpp went away mid-run |
| `DISABLED_BY_POLICY` | An org policy blocked it |
| `UNSUPPORTED_DEVICE` / `UNSUPPORTED_OS_VERSION` | Device or OS below minimum |
| `CANCELED` | You, the panel's Stop, or a timeout |

---

## Launch arguments

```powershell
Cephable.exe --model "Gemma 4 M" --port 4321
Cephable.exe --family Gemma --size M --port 4321
```

`--size-code` aliases `--size`; `--automate-http-port` aliases `--port`. They override the *process*, not the account, and never bypass the license or enable the server. Failures show up as `launchModelSelectionError` on `/health`. **The access key is deliberately not accepted as an argument.**
