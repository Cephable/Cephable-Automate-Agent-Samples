# Cephable Automate Agent Samples

Real, runnable sample applications built on the **Cephable Automate HTTP Server** — the opt-in local API inside the Cephable desktop app that lets any program on the device drive Cephable's on-device AI agent.

The samples use Cephable in its two modes. Most run the *shipping* Cephable assistant: the same agent loop, system prompt, 47 built-in tools, AI Skills, MCP servers, and local llama.cpp model that the Cephable app itself uses (`cephable-agent`). The rest put **your own** agent loop in charge and use Cephable as the model inside it (`cephable-model`). Nothing in these samples sends your prompts or your data to a cloud model — inference and tool execution happen on the machine.

```
your app ──HTTP──▶ 127.0.0.1:4317 ──▶ Cephable desktop app
                                        │
                                        ├─ agent loop (deepagents)
                                        ├─ built-in tools · AI Skills · MCP servers
                                        ├─ your custom tools  ◀── the interesting part
                                        └─ local model (llama.cpp)
```

---

## The samples

| Sample | Stack | What it shows |
|---|---|---|
| **[python-langchain-tools](samples/python-langchain-tools)** | Python 3.10+ · LangChain | A support-triage agent where **your own Python functions** are the tools. Two integration styles side by side: LangChain's `bind_tools` against the OpenAI-compatible route, and the native `/v1/runs` park/resume loop. |
| **[python-langgraph-own-loop](samples/python-langgraph-own-loop)** | Python 3.10+ · LangGraph | The same support desk turned inside out: **a LangGraph loop you own**, with Cephable as `cephable-model` inside it. Your system prompt, your conversation state, only your tools — plus a human **approval gate** before anything is changed, streaming, parallel tool calls and multi-turn follow-ups. |
| **[winui-windows-ai-agent](samples/winui-windows-ai-agent)** | C# · WinUI 3 · Windows App SDK | A Windows desktop agent that combines **Cephable's agent with Windows' own on-device AI** — Phi Silica for local rephrasing/summarizing and Windows OCR for reading text out of images — then hands the results to Cephable as custom tools. Fully on-device, end to end. |
| **[nextjs-vercel-ai-ui](samples/nextjs-vercel-ai-ui)** | TypeScript · Next.js · Vercel AI SDK + AI Elements | A chat UI built from Vercel's **AI Elements** components, streaming Cephable's **real agent steps and tool calls** into the browser as they happen. Two of its tools draw straight into the page — the agent decides to render a timeline, and one appears. |
| **[nextjs-ai-sdk-agent-loop](samples/nextjs-ai-sdk-agent-loop)** | TypeScript · Next.js · Vercel AI SDK | The mirror image of the sample above: the AI SDK's **`ToolLoopAgent` owns the loop** and Cephable is `cephable-model` inside it. Only **your** tools run, and one of them is gated behind a real **approval** that suspends the run until a human answers. |
| **[public-gateway](samples/public-gateway)** | TypeScript · Node · Fastify | A hardened reverse proxy that safely exposes one machine's Cephable server to the internet — its own auth, its own rate limits, and a request policy that strips the dangerous parts of the API instead of trusting remote callers. |

Each sample folder has its own README with prerequisites, a one-command run, a **demo script** for showing it to someone, and a walkthrough of how it works.

### No Cephable Professional licence yet?

Every sample also runs against **[tools/fake-cephable](tools/fake-cephable)** — a standard-library
Python stand-in that speaks the protocol without running a model. It is how the samples in this repo are
tested, and it is enough to see the shape of an integration before you have a licence.

---

## Before you run anything

Every sample needs the same two things. Full detail in **[docs/getting-started.md](docs/getting-started.md)**.

**1. Turn on the server in Cephable.** Open the Cephable desktop app → **Extensions** → **Cephable features** → **Build & Extend** → **Automate HTTP Server**. Enable it, then open its detail view and confirm it says **Running**.

Requires a **Cephable Professional** account — the extension does not appear otherwise.

**2. Copy the access key and put it in your environment.**

```bash
# macOS / Linux
export CEPHABLE_AUTOMATE_KEY='paste-the-key-from-the-extension-detail-view'
```

```powershell
# Windows PowerShell
$env:CEPHABLE_AUTOMATE_KEY = 'paste-the-key-from-the-extension-detail-view'
```

Then check it works:

```bash
curl -sS http://127.0.0.1:4317/health -H "Authorization: Bearer $CEPHABLE_AUTOMATE_KEY"
```

You want `"status": "ok"`, `"busy": false`, and `"workflowStatus": "idle"`.

> **Don't hardcode the port.** Cephable moves to the next free port (`4317`–`4328`) when its preferred one is taken. Every sample here discovers it. Read the **Endpoint** field in the extension detail view if you need to know which one it landed on.

---

## Five things worth knowing before you read the code

These shape every sample, and they are the things people get wrong first.

1. **One run at a time.** The app has a single inference slot, shared with the user's own panel. A second concurrent run gets `409`. Every sample gates on `/health` before starting and handles `409` rather than retrying into it.
2. **Runs are long — stream them or wait generously.** A run takes tens of seconds to minutes for real agent work. Either block (and set client timeouts *above* the server's `timeoutMs`) or send `stream: true` for Server-Sent Events: OpenAI chunks on `/v1/chat/completions`, named progress events on `/v1/runs`. The agent loop is not token-streamed; the stream keeps the connection alive and delivers the answer when it is ready. A client that disconnects mid-run cancels it.
3. **A failed run is `HTTP 500` with a complete record.** Tell "the run failed" from "the request failed" by checking `schemaVersion === 1`, not by status code.
4. **No CORS.** A browser page on an `http(s)://` origin cannot call the server — there are no CORS headers and no `OPTIONS` handler. Call it from a native process, a Node/Electron main process, or your own server. (That is why the Next.js sample proxies through a route handler.)
5. **Custom tools are per-run.** Nothing a sample declares is written to the user's configured Tools library, and an app-started run is completely unaffected.

---

## Two ways to give the agent your own tools

Both are demonstrated across these samples; they suit different integrations.

**Inline MCP servers** — you host an MCP server, Cephable connects to it for that run:

```jsonc
POST /v1/runs
{
  "prompt": "Look up order 4471 and draft the customer a reply.",
  "mcpServers": [{
    "name": "my-app",
    "description": "Order lookup and customer records",
    "transport": "http",
    "url": "http://127.0.0.1:9123/mcp"
  }]
}
```

**Caller-executed tools** — you declare a tool by JSON Schema and run it yourself. The run *parks*, hands you the call, and resumes when you post the result:

```jsonc
POST /v1/runs
{
  "prompt": "Look up order 4471 and draft the customer a reply.",
  "clientTools": [{
    "name": "lookup_order",
    "description": "Fetch an order by id",
    "parameters": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
  }]
}
→ { "status": "awaiting_tool_results", "toolCalls": [...], "resumeToken": "..." }

POST /v1/runs/{resumeToken}/tool-results
{ "results": [{ "id": "...", "result": "Order 4471: 2x widget, shipped 2026-09-02" }] }
```

The second mechanism is also wired to OpenAI's `tools` on `/v1/chat/completions`, which is what makes LangChain's `bind_tools` work with no Cephable-specific client code.

**Or skip Cephable's agent entirely** — use `model: "cephable-model"` and run the loop yourself. Cephable then behaves like an OpenAI chat model: your system prompt, your full message history every call, your tools, streaming and sampling parameters. It still handles inputs longer than the device's context window and long-form output behind the scenes. See [python-langgraph-own-loop](samples/python-langgraph-own-loop) and [nextjs-ai-sdk-agent-loop](samples/nextjs-ai-sdk-agent-loop).

---

## Security, in one paragraph

The access key is **as powerful as the user**. Holding it means running the assistant with their file access, their installed apps, and their connected accounts. It is a password, not a client id: read it from the environment or an OS keychain, never commit it, never put it on a command line (other local processes can read those), and never ship it inside an app. Two request options deserve real thought before you enable them — `allowDestructiveTools` (which approves `delete_path` / `run_command` / `move_path`) and inline MCP servers with `transport: "stdio"` (which spawn a local process with your `command` and `args`). The [public-gateway](samples/public-gateway) sample exists partly to show how to refuse both on behalf of remote callers.

---

## Documentation

- **[docs/getting-started.md](docs/getting-started.md)** — enabling the server, finding the port, verifying the key, common first-run failures
- **[docs/api-cheatsheet.md](docs/api-cheatsheet.md)** — the whole contract on one page
- **[docs/showcase-guide.md](docs/showcase-guide.md)** — running these as a live demo: what to say, what to show, what to have ready
- **Full reference:** [Cephable Developer Docs → Automate HTTP Server](https://developers.cephable.com/docs/automate-http-server)

---

## Contributing

New samples and fixes are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The bar for a sample here is that it **runs from a clean clone with one command**, does something a prospect would recognize as useful, and is honest about what it does and does not do.

## License

MIT — see [LICENSE](LICENSE).
