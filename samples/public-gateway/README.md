# Public gateway

A hardened reverse proxy that exposes **one machine's** Cephable server to remote callers — with its own
authentication, its own rate limits, a queue for the single inference slot, and a request policy that
refuses the parts of the API a remote caller must not have.

This is the sample to read if you are thinking *"can we host this?"* The answer is yes, and this is the
shape of the work.

---

## The problem it solves

Cephable's local API trusts its caller completely, and it is right to: it binds `127.0.0.1`, and whoever
holds the access key is assumed to be the person at the keyboard. That assumption is doing a lot of
load-bearing work. Put the API on a public address unchanged and a stranger can:

| Ask for… | …and get |
|---|---|
| `allowDestructiveTools: true` | `delete_path`, `run_command` and `move_path` approved on your machine |
| `mcpServers` with `transport: "stdio"` | A process spawned on your machine with their `command` and `args` — **not** gated by `allowDestructiveTools` |
| `restrictToWorkspace: false` | The agent's file tools pointed at your whole disk |
| `selectedSkillIds` / `selectedMcpServerIds` | Your configured connectors, holding your credentials |
| `continuation: true` | The conversation you were having in the app |
| any run record | Absolute paths, file contents, your CPU, your workspace location |

So the gateway does not proxy. It **re-authenticates, rewrites, and trims.**

---

## What it does

**Its own keys.** Remote callers use gateway keys (`cgw_…`), not Cephable's. The Cephable key never
leaves the gateway process. Keys are stored as SHA-256 hashes, so the config file is not a set of
working credentials, and revoking one caller does not disturb the others.

**An allowlist, not a denylist.** The forwarded request is built fresh from fields the policy
recognises. When Cephable ships a new option, it does not silently become a new remote capability.

**Forced-safe defaults.** Every run goes upstream with `restrictToWorkspace: true`,
`allowDestructiveTools: false`, `continuation: false`, and `trace`/`events` stripped. The response tells
the caller what changed in an `x-gateway-policy` header, so a capped timeout is discoverable rather than
mysterious.

**Per-caller tool permissions.** Caller-executed tools (`clientTools`) are always allowed — they run in
the *caller's* process, not on the host. Inline MCP servers are per-key, and `stdio` is refused for
everyone.

**Run ownership.** The gateway remembers which caller owns each parked run. One caller cannot resume or
cancel another's — and nobody can cancel the run the *person at the machine* started from the app's own
panel, which unguarded `/v1/automate/cancel` would allow.

**A queue, not a 409.** There is one inference slot. Requests serialise through a bounded queue with a
wait ceiling, and refuse cleanly with `503` when it is full.

**A response that reveals nothing about the host.** No model name, no app version, no accelerator, no
CPU, no workspace path, no `toolArgs`, no `producedFilePath`. The answer, the status, timings, and a
shape of the steps.

---

## Run it

```bash
cd samples/public-gateway
npm install

# 1. Mint a key for a caller. Shown once; only its hash is stored.
npm run keygen -- --label "demo client" --id demo

# 2. Put the printed JSON object in gateway.config.json
cp gateway.config.example.json gateway.config.json
#    …and paste over the keys array

# 3. Run it (Cephable's own key comes from the environment, as always)
export CEPHABLE_AUTOMATE_KEY='paste-cephable-key'
npm start
```

```
Cephable found at http://127.0.0.1:4317
  app 4.2.1 · model gemma-4-4b-it-Q4_K_M.gguf · status idle

Gateway listening on http://127.0.0.1:8787
  1 API key(s) configured: demo
```

Then call it as a remote client would:

```bash
GW=http://127.0.0.1:8787
KEY=cgw_...

curl -sS $GW/v1/status -H "Authorization: Bearer $KEY"

curl -sS $GW/v1/runs -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"prompt":"Summarize the newest file in the workspace."}'

# Refused, with the reason:
curl -sS $GW/v1/runs -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"prompt":"hi","allowDestructiveTools":true}'
```

```jsonc
{
  "error": {
    "message": "The request was refused by gateway policy.",
    "type": "policy_violation",
    "rejections": [{
      "field": "allowDestructiveTools",
      "reason": "Refused. This would approve delete_path, run_command and move_path on the host machine. A remote caller cannot enable it."
    }]
  }
}
```

**Tests** — 29 of them, and they are the reason to trust the policy:

```bash
npm test
npm run typecheck
```

> **No Cephable licence?** Point it at the [fake server](../../tools/fake-cephable):
> `CEPHABLE_ENDPOINT=http://127.0.0.1:4319 CEPHABLE_AUTOMATE_KEY=fake-token-with-at-least-24-characters npm start`

---

## API

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/healthz` | none | Liveness. Says `{"status":"ok"}` and nothing else |
| `GET` | `/v1/status` | key | Whether the assistant is free, and your queue position |
| `POST` | `/v1/runs` | key | Run a task. Policy-checked and rewritten |
| `POST` | `/v1/runs/:token/tool-results` | key | Resume *your* parked run |
| `POST` | `/v1/runs/cancel` | key | Cancel *your* run |

Deliberately not exposed: `/v1/chat/completions` (an OpenAI-shaped surface this policy has not been
written against), `/v1/automate/models/select` (would change the host user's session model), and
`/v1/automate/cancel` (would stop the host user's own run).

Accepted run fields: `prompt`, `taskId`, `timeoutMs`, `thinkingLevel`, `additionalWorkflowPrompt`,
`answerContract`, `include`, `clientTools`, `mcpServers`. Everything else is dropped and reported in
`x-gateway-policy`.

---

## Demo script

Four minutes, and it is a security conversation more than a product one.

1. **Frame it.** "Cephable runs on the desktop. A partner asks: can we call it from our cloud? Here is
   what that has to look like."
2. **Show `/v1/status` working** with a gateway key. Ordinary, boring, fine.
3. **Then try to abuse it.** Send `allowDestructiveTools: true`. Read the refusal out loud — it names
   the tools it would have approved. Send a `stdio` MCP server. Read that refusal too: *"this would
   spawn a process on the host with your command, and it is not covered by the destructive-tools
   flag."* This is the moment that earns trust with a security reviewer.
4. **Run a real task,** then show the response. Point out what is *not* in it: no file paths, no model
   name, no machine details. Then show the same run in Cephable's own panel on the host, where all of
   that *is* visible. "Local caller, full detail. Remote caller, the answer."
5. **Show `x-gateway-policy`.** "It tells you what it changed. Nothing is silent."
6. **Then `npm test`.** 29 tests, each one a refusal that cannot regress.

---

## Deploying this for real

The sample binds `127.0.0.1` on purpose. Before it faces the internet:

**TLS is not optional.** Every gateway key crosses the network on every request. Put Caddy, nginx, or a
cloud load balancer in front with a real certificate. Setting `GATEWAY_HOST=0.0.0.0` prints a warning
for exactly this reason.

**Do not port-forward a laptop.** Prefer an outbound tunnel — Cloudflare Tunnel, Tailscale Funnel, ngrok
— so the machine is not directly reachable and you get an identity layer for free. If you must open a
port, put it behind a firewall rule that allows only your caller's addresses.

**One gateway, one machine.** The queue is in-process because there is exactly one inference slot. For
several machines, put a broker in front and route by host; do not point one gateway at several Cephable
instances.

**Watch the host, not just the gateway.** `GET /v1/status` tells you whether the assistant is free. If
it is permanently busy, someone's run is stuck — a parked run with a caller that vanished self-cancels
after two minutes, but a long task does not.

**The host user is a user too.** They share the inference slot with your callers. A machine serving
remote traffic all day is not a machine someone can also work on.

**Environment variables:**

| | | |
|---|---|---|
| `CEPHABLE_AUTOMATE_KEY` | *required* | Cephable's key. Never sent to callers |
| `CEPHABLE_ENDPOINT` | auto-discovered | Pin it to skip the port sweep |
| `GATEWAY_CONFIG` | `./gateway.config.json` | Keys file |
| `GATEWAY_HOST` | `127.0.0.1` | `0.0.0.0` only behind TLS |
| `GATEWAY_PORT` | `8787` | |
| `GATEWAY_RATE_LIMIT` | `20` | Requests per minute, per key |
| `GATEWAY_MAX_QUEUE` | `4` | Waiting callers before `503` |
| `GATEWAY_MAX_QUEUE_WAIT_MS` | `60000` | Queue wait ceiling |

---

## Where to look

| File | What it is |
|---|---|
| **`src/policy.ts`** | **The interesting file.** Every refusal, every rewrite, and why. |
| `src/auth.ts` | Key generation, hashing, constant-time lookup across all keys |
| `src/upstream.ts` | Port discovery, the slot queue, run ownership |
| `src/app.ts` | Routes, auth hook, rate limiting, audit logging |
| `src/server.ts` | Startup, config, the `0.0.0.0` warning |
| `test/gateway.test.ts` | 29 tests, mostly "this refusal still refuses" |

### What is not in the audit log

Prompts and answers. They are user content, and a gateway log is the worst place for it to accumulate.
The log records caller id, prompt *length*, timeout, tool counts, status and duration. Access keys are
never logged in any form.

### Why constant-time comparison across every key

`authenticate()` hashes the candidate once and compares against every configured key without
short-circuiting. Response timing therefore does not reveal how many keys exist or how close a guess
was. It costs microseconds; the alternative is a slow but real oracle.
