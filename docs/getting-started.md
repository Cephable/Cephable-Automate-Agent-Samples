# Getting started

Everything in this repo talks to one thing: the Automate HTTP Server inside the Cephable desktop app. Get that working once and every sample runs.

---

## 1. Requirements

| | |
|---|---|
| **Cephable desktop app** | Running and signed in. The server lives inside the app process — closing Cephable stops it. There is no background service. |
| **Cephable Professional** | The extension is gated behind a feature flag and will not appear for accounts without it. |
| **A tool-capable model downloaded** | Cephable prompts for this the first time you use AI Workflows. Automate requires tool calling, so a non-tool model will not work. |
| **Secure OS storage** | Windows DPAPI and macOS Keychain work by default. On Linux you need a real keyring (GNOME Keyring, KWallet) — the plaintext `basic_text` fallback is refused. |
| **Same machine** | The listener binds `127.0.0.1` only. |

---

## 2. Enable the server

1. Open Cephable.
2. Go to **Extensions**.
3. Under **Cephable features → Build & Extend**, find **Automate HTTP Server**.
4. Enable it from the card.
5. Open the card to see its detail view.

The detail view gives you three things:

- **Endpoint** — the base URL, e.g. `http://127.0.0.1:4317`. This is authoritative; read it rather than assuming.
- **Port** — the port actually bound.
- **Access key** — the bearer token, 43 characters of URL-safe base64.

Confirm the status reads **Running** before going further.

---

## 3. Put the key in your environment

Click **Copy access key**, then:

```bash
# macOS / Linux — add to your shell profile if you want it to persist
export CEPHABLE_AUTOMATE_KEY='paste-the-key-here'
```

```powershell
# Windows PowerShell — current session
$env:CEPHABLE_AUTOMATE_KEY = 'paste-the-key-here'

# Windows PowerShell — persist for your user
[Environment]::SetEnvironmentVariable('CEPHABLE_AUTOMATE_KEY', 'paste-the-key-here', 'User')
```

Optionally pin the endpoint too, which skips the port sweep every sample does at startup:

```bash
export CEPHABLE_ENDPOINT='http://127.0.0.1:4317'
```

> **Never put the key on a command line** (`--key abc123`). Operating systems expose process command lines to other local processes — which is exactly why Cephable itself refuses to accept the key as a launch argument.

---

## 4. Verify

```bash
curl -sS http://127.0.0.1:4317/health -H "Authorization: Bearer $CEPHABLE_AUTOMATE_KEY"
```

A healthy response:

```jsonc
{
  "status": "ok",
  "service": "cephable-agent",
  "appVersion": "4.2.1",
  "platform": "win32",
  "workflowStatus": "idle",
  "busy": false,
  "awaitingToolResults": false,
  "modelName": "gemma-4-4b-it-Q4_K_M.gguf",
  "workspace": "C:\\Users\\you\\AppData\\Roaming\\Cephable\\automate-http-workspace",
  "backend": { "flavorId": "vulkan", "accelerator": "vulkan", "cpuFallback": false },
  "contextSize": 16384
}
```

**Ready to run** means `busy: false` and `workflowStatus` is `idle` or `terminated`.

Then try a real run — this one is deliberately trivial so it finishes fast:

```bash
curl -sS http://127.0.0.1:4317/v1/runs \
  -H "Authorization: Bearer $CEPHABLE_AUTOMATE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Reply with exactly the word: ready","include":{"steps":false,"trace":false,"events":false}}'
```

Watch the AI Workflows panel in Cephable while it runs. The run appears there exactly as if you had typed it, because it *is* the same run.

---

## 5. Finding the port when 4317 doesn't answer

Cephable prefers `4317`. If something else holds it — most often a second Cephable instance, a stale process, or an OpenTelemetry collector, which also defaults to 4317 — Cephable binds the next free port in a twelve-port window and the extension detail view says so.

Sweep the window and confirm you found Cephable rather than something else:

```bash
for port in $(seq 4317 4328); do
  body=$(curl -sS --max-time 2 "http://127.0.0.1:$port/health" \
    -H "Authorization: Bearer $CEPHABLE_AUTOMATE_KEY" 2>/dev/null)
  if echo "$body" | grep -q '"service":"cephable-agent"'; then
    echo "Cephable is on port $port"
    break
  fi
done
```

```powershell
4317..4328 | ForEach-Object {
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:$_/health" -TimeoutSec 2 `
            -Headers @{ Authorization = "Bearer $env:CEPHABLE_AUTOMATE_KEY" }
        if ($h.service -eq 'cephable-agent') { "Cephable is on port $_"; break }
    } catch { }
}
```

Checking `service === "cephable-agent"` is the part that matters — a 200 from some other local service is not a Cephable server.

To force a port (useful in a lab or demo rig), launch Cephable with `--port`:

```powershell
Cephable.exe --port 4321
```

Cephable is single-instance, so relaunching with a new `--port` rebinds the running app's server.

---

## 6. First-run failures, in order of likelihood

**Connection refused**
1. Cephable isn't running, or was quit to the tray and then killed.
2. The extension isn't enabled — check the detail view says **Running**.
3. The port moved. Sweep it (above).
4. You used `localhost`. On some systems that resolves to `::1` first and the server only listens on IPv4 — use the literal `127.0.0.1`.
5. You're calling from a browser page. You can't: no CORS headers, no `OPTIONS` handler, so preflight fails. Call from a server, a native app, or Electron's main process.

**`401 Unauthorized`**
1. The key was regenerated in the app — rotation is immediate, with no grace period.
2. A trailing newline from a copy-paste or `$(cat keyfile)`. Trim it.
3. The header isn't exactly `Authorization: Bearer <key>`.
4. You're hitting a different service on that port.

A `401` on `/health` is expected behavior, not a misconfiguration — there are no anonymous routes.

**`409 Conflict`**

A run is already going, possibly one the *user* started in the panel. Poll `/health` until ready, or `POST /v1/automate/cancel` (safe to call when nothing is running). Don't retry in a tight loop, and turn off automatic retries in your HTTP client.

**The extension won't enable**
- *"Secure operating-system storage is unavailable"* — usually Linux without an unlocked keyring.
- *"A Cephable Professional license is required"* — the account lacks the feature flag.

**A run returns `HTTP 500`**

Check for `schemaVersion: 1` in the body. If it's there, the run happened and did not succeed — read `status` and `errorCode` and look at the failed step. That is not a server fault.

---

## 7. Where to go next

- Pick a sample from the [root README](../README.md).
- Skim the [API cheatsheet](api-cheatsheet.md) — one page, the whole contract.
- Full reference: [Cephable Developer Docs → Automate HTTP Server](https://developers.cephable.com/docs/automate-http-server).
