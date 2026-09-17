# Showcase guide

Running these as a live demo. Written for whoever is standing in front of a prospect or a partner.

---

## The 30-second version

> "Cephable runs an AI agent on the device — the model, the tools, all of it. No API key, no tenant, no
> data leaving the machine. And it has a local API, so your software can use that agent as if it were a
> library. Let me show you three of those, and then I'll turn off the Wi-Fi."

The Wi-Fi line is not a gimmick. It is the demo. Everything else is context for it.

---

## Which sample for which room

| Audience | Show | Because |
|---|---|---|
| **Developers / technical eval** | [python-langchain-tools](../samples/python-langchain-tools) | LangChain works with a two-line change. Familiar ground, immediate "oh, that's it?" |
| **Product / business** | [nextjs-vercel-ai-ui](../samples/nextjs-vercel-ai-ui) | Visual, and built from Vercel's own AI Elements components. The agent draws a timeline and writes a draft on screen. |
| **Windows / enterprise IT** | [winui-windows-ai-agent](../samples/winui-windows-ai-agent) | Three on-device AI systems cooperating, including Windows' own. Nothing to procure. |
| **Security / architecture review** | [public-gateway](../samples/public-gateway) | Shows you have thought about the boundary, and can refuse things. Earns more trust than any feature. |

If you only get one: **the Next.js one**, then turn off the network.

---

## Setup, the day before

Do this the day before, not ten minutes before.

1. **Enable the Automate HTTP Server** in Cephable and copy the key into your shell profile so it
   survives a reboot. See [getting-started.md](getting-started.md).
2. **Do one warm-up run of each sample you plan to show.** The first run after Cephable launches loads
   the model, which takes seconds to tens of seconds and looks like a hang. Phi Silica's first call may
   download a model, which takes minutes.
3. **Check `/health` for `cpuFallback`.** If GPU acceleration failed, everything is an order of
   magnitude slower and your demo will drag:
   ```bash
   curl -sS http://127.0.0.1:4317/health -H "Authorization: Bearer $CEPHABLE_AUTOMATE_KEY"
   ```
4. **`npm install` / `pip install` everything.** Not on the call.
5. **Open Cephable's AI Workflows panel** and leave it visible on a second monitor if you have one. Runs
   appear there live, which makes the point that this is the real assistant and not a side channel.
6. **Close anything else using the machine's GPU.**

---

## During the demo

**Narrate the tool calls.** They appear one at a time, and each one is a sentence:
*"there it is reading the order… now checking whether the part is even in stock… now pulling the actual
policy text."* This is the difference between "a chatbot said something" and "it asked our systems."

**Do not hide a failure.** If a tool errors, that is a feature — the agent reads the error and adapts.
Say so: *"it asked for an order that doesn't exist, and the tool told it which ones do. Watch it
correct itself."* Recovering in front of someone is more persuasive than a clean run.

**One inference slot.** If you get a `409`, someone (or you, in another window) has a run going. Say
*"one model, one slot, it's shared with the app"* and cancel it — it is an honest architectural fact,
not a bug.

**Then turn off the Wi-Fi and do it again.** Genuinely disable it; don't mime it. This is the moment
people remember.

---

## Questions you will get

**"Is this actually local, or local-ish?"**
Actually local. The model is a GGUF on disk served by a llama.cpp process inside the app; the agent loop
and the tools run in the app's own processes. The run record tells you which model file and which GPU
accelerator served it. Turning off the network proves the rest.

**"What model?"**
Whatever the user has selected — see `/v1/automate/models`. You can pin one per integration with
`/v1/automate/models/select`. It is a small model, so it is fast and it does better with sharply scoped
tasks and well-described tools than with sprawling prompts.

**"How do we host this for our whole company?"**
You mostly do not — it runs on each user's device, which is the point. When you genuinely need remote
access to one machine, [public-gateway](../samples/public-gateway) is the shape of it: your own auth,
your own rate limits, and a policy that refuses the dangerous parts of the API on the host's behalf.

**"Can it use our internal systems?"**
Two ways, both in these samples. Host an MCP server and declare it inline per run, or declare tools by
JSON Schema and execute them in your own process. Neither writes anything into the user's configuration.

**"What about prompt injection?"**
Live, and worth taking seriously. A run that reads a file, a web page, or a third-party MCP result can
be steered by content in it, and the agent has real tools. The mitigations are in the API and shown in
the samples: `restrictToWorkspace` to confine file and shell tools, `allowDestructiveTools` off (the
default) so `delete_path` / `run_command` / `move_path` are refused, and — for anything remote — the
gateway's policy layer. Do not put untrusted content into an unattended run with destructive tools on.

**"What does it cost per request?"**
Nothing per request. It is the user's hardware.

**"Does it work offline?"**
You just watched it.

**"How fast?"**
Depends entirely on the machine and the model. The run record reports `durationMs` and `tps` honestly —
show them the real numbers on the real laptop rather than quoting a figure.

---

## What not to claim

Worth being straight about, because these all come back later:

- **It is not a frontier model.** It is a small local one. It is very good at scoped work with good
  tools and will disappoint anyone expecting GPT-5-class reasoning on an open-ended question.
- **It is not concurrent.** One run at a time, per machine, shared with the human using the app. A
  machine serving requests all day is not a machine someone can also work on.
- **It does not stream tokens.** Runs block until they finish. The Next.js sample streams *events*,
  which is real, but it is not a token stream.
- **A browser page cannot call it directly.** No CORS headers, no `OPTIONS` handler. Server-side,
  native, or Electron main process only.
- **The access key is as powerful as the user.** Do not hand it to a partner and call it an API key.
