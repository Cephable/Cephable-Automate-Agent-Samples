# WinUI + Windows AI

**Cephable Desk** — a Windows desktop agent where **three separate on-device AI systems cooperate** and
none of them touches a network:

| | Does | Runs on |
|---|---|---|
| **Windows OCR** (`TextRecognizer`) | Reads text out of the image you paste | Windows App SDK, on-device |
| **Phi Silica** (`LanguageModel` + `TextSummarizer` / `TextRewriter`) | Summarizes and rewrites text | Windows App SDK, on the NPU |
| **Cephable** | Decides what to do, calls the other two as tools, chains the results | Cephable desktop app, local llama.cpp |

Paste a screenshot of an error dialog. Ask *"what is this telling me, and what should I do about it?"*
Windows reads the pixels, Cephable's agent decides it needs the text, summarizes it through Phi Silica,
reasons about it, and saves you a note. Air-gapped, the whole way through.

---

## Why this pairing

Windows' AI APIs are excellent at narrow, fast, well-defined jobs — read this image, tighten this
paragraph — and they need no prompt, no tools, and no orchestration. What they do not do is *decide*.

Cephable is the other half: an agent loop with ~55 built-in tools, AI Skills, and MCP servers, which can
be handed your app's functions and will work out a sequence. Give it Windows' features as tools and you
get something neither provides alone, with a privacy story that survives contact with a security review.

---

## What this shows

- **Windows AI features as Cephable tools.** `summarize_locally` and `rewrite_locally` are Phi Silica;
  `read_screen_text` is Windows OCR. The agent picks when to use them.
- **Graceful degradation that is actually graceful.** Phi Silica needs a Copilot+ PC with an NPU. On a
  machine without one, every tool reports *why* it is unavailable, the agent reads that and works
  around it, and the app still does useful work. There is a `check_windows_ai` tool for exactly this.
- **A WinUI app driving a long-running agent properly.** Cancellation that cancels the *run* and not
  just the HTTP request, a shared inference slot handled with a readiness gate, and worker-thread
  events marshalled onto the UI thread.
- **A tool whose output is UI.** `save_note` appends to a bound collection, so the note appears in the
  sidebar the moment the agent writes it.

---

## Prerequisites

| | |
|---|---|
| **Windows 11** | Build 22621+ recommended. The app runs on 19041+; the AI features check their own availability |
| **.NET 9 SDK** | `dotnet --list-sdks` |
| **Cephable** | Automate HTTP Server enabled, `CEPHABLE_AUTOMATE_KEY` set — see [docs/getting-started.md](../../docs/getting-started.md) |
| **Copilot+ PC** | *For Phi Silica only.* Without an NPU those two tools report unavailable and everything else works |

## Run it

```powershell
cd samples\winui-windows-ai-agent

$env:CEPHABLE_AUTOMATE_KEY = 'paste-the-key-from-the-extension-detail-view'

dotnet build -c Debug -r win-x64
dotnet run -c Debug -r win-x64
```

The status line tells you what this machine has:

```
Cephable 4.2.1 at http://127.0.0.1:4317  |  gemma-4-4b-it-Q4_K_M.gguf  |  vulkan
Phi Silica: ready  |  Windows OCR: ready
```

Then:

1. Screenshot something with **Win+Shift+S** (an error dialog, a receipt, a form).
2. Click **Paste image**. Windows OCR reads it — the extracted text appears in the panel.
3. Ask the agent something, e.g. *"What is this error telling me? Summarize it and save me a note with
   what to try."*

> **No Cephable licence yet?** Point it at the [fake server](../../tools/fake-cephable). The Windows AI
> parts are real either way; only Cephable's agent is stubbed.
>
> ```powershell
> $env:CEPHABLE_ENDPOINT = 'http://127.0.0.1:4319'
> $env:CEPHABLE_AUTOMATE_KEY = 'fake-token-with-at-least-24-characters'
> ```

---

## Demo script

Five minutes, and the last beat is the one that sells it.

1. **Read the status line aloud.** "Local model, local GPU, Windows' own AI ready. Nothing configured,
   no API keys."
2. **Screenshot a real error dialog** — ideally something ugly and technical from the machine you are
   demoing on. Paste it. The OCR text appears. "Windows just read that. On the NPU."
3. **Ask:** *"What is this telling me, and what should I try first?"*
4. **Narrate the tool calls as they appear.** `read_screen_text` → `summarize_locally` → `save_note`.
   Point out the middle one: **"the agent decided to hand the long text to Windows' summarizer rather
   than chew through it itself. Two different local models, one deciding to use the other."**
5. **The note appears in the sidebar** as the agent writes it.
6. **Then turn off Wi-Fi and do the whole thing again.** This is the moment. Screenshot, OCR, summarize,
   reason, save — with no network. "This is what we mean by on-device. Not 'we don't log your data' —
   there is no request to log."

Have ready: the app already built and launched once (first launch JITs; Phi Silica's first call may also
download its model), a screenshot worth reading, and Cephable's AI Workflows panel visible so they can
see the same run appear there.

---

## How it works

```
  you paste an image
          │
          ▼
  Windows OCR  (TextRecognizer, on-device)
          │  extracted text
          ▼
  AgentTools.ScreenText ─────────────────────┐
                                             │
  your prompt ──▶ CephableClient.RunWithToolsAsync
                                             │
                          POST /v1/runs  { clientTools: [...] }
                                             │
                            ◀── awaiting_tool_results
                                             │
                          AgentTools.InvokeAsync(name, args)
                              ├─ read_screen_text   → the OCR text
                              ├─ summarize_locally  → Phi Silica
                              ├─ rewrite_locally    → Phi Silica
                              ├─ save_note          → the UI's notes list
                              └─ check_windows_ai   → availability
                                             │
                          POST /v1/runs/{token}/tool-results
                                             │
                            ◀── …repeat, or the finished answer
```

| File | What it is |
|---|---|
| **`Services/WindowsAiService.cs`** | **The interesting file.** Phi Silica and Windows OCR, with readiness checks and honest failure messages. |
| **`Services/AgentTools.cs`** | The five tools, their JSON Schema declarations, and dispatch. |
| `Services/CephableClient.cs` | Port discovery, run-vs-request errors, the park/resume loop. |
| `MainWindow.xaml(.cs)` | UI, clipboard and drop handling, cancellation, thread marshalling. |

### Windows AI API notes (verified against Windows App SDK 1.7)

The API surface moved between SDK versions, so for the record — this is what actually compiles against
`Microsoft.WindowsAppSDK 1.7.250606001`:

```csharp
// Availability. Throws on a machine without the feature at all, so wrap it.
AIFeatureReadyState state = LanguageModel.GetReadyState();
AIFeatureReadyResult ready = await LanguageModel.EnsureReadyAsync();   // can take minutes, first time

// Text intelligence is separate classes over a LanguageModel — there is no raw
// GenerateResponseAsync on LanguageModel in this version.
using LanguageModel model = await LanguageModel.CreateAsync();
LanguageModelResponseResult result = await new TextSummarizer(model).SummarizeAsync(text);
LanguageModelResponseResult rewritten = await new TextRewriter(model).RewriteAsync(text);

// OCR
using TextRecognizer recognizer = await TextRecognizer.CreateAsync();
ImageBuffer buffer = ImageBuffer.CreateForSoftwareBitmap(bitmap);
RecognizedText text = recognizer.RecognizeTextFromImage(buffer);
foreach (RecognizedLine line in text.Lines) { /* line.Text */ }
```

`LanguageModelResponseStatus` has outcomes beyond success that are *normal*, not bugs —
`PromptBlockedByContentModeration`, `ResponseBlockedByContentModeration`, `PromptLargerThanContext`.
`WindowsAiService.Unwrap` turns each into a message the agent can explain to the user, which is far more
useful than a blank result.

### Four things worth copying

**Check readiness, and say why.** `CheckLanguageModel()` returns a reason, not a boolean, and the tool
returns that reason to the agent as a tool error. The agent then tells the user *"this machine does not
have an NPU, so I summarized it myself"* instead of failing.

**Cancel the run, not just the request.** `_running.Cancel()` only abandons the HTTP call; the run keeps
going inside Cephable and holds the single inference slot. `OnStopClicked` calls
`CephableClient.CancelAsync` first.

**Gate on readiness.** One inference slot, shared with the person using the Cephable app.
`WaitUntilReadyAsync` waits; the `409` path explains rather than just failing.

**Marshal to the UI thread.** The park/resume loop runs off-thread and fires events per tool call.
`Add()` and the `NoteSaved` handler both go through `DispatcherQueue.TryEnqueue`.

### Unpackaged, and what that costs

`WindowsPackageType=None` means `dotnet run` works with no MSIX deployment, which is the right trade for
a sample. Two consequences:

- The file picker needs a window handle passed by hand (`InitializeWithWindow.Initialize`) — see
  `OnOpenClicked`.
- Some Windows AI features want package identity depending on the Windows build. If Phi Silica reports
  unavailable on a machine you believe should have it, packaging the app (`EnableMsixTooling` is already
  on) is the first thing to try.

---

## Troubleshooting

| | |
|---|---|
| "CEPHABLE_AUTOMATE_KEY is not set" | Set it in the same shell you run from — `$env:` vars do not cross shells. |
| "No Cephable server answered on 127.0.0.1:4317-4328" | Cephable is not running, or the extension is off. |
| "Cephable is busy with another run" | One inference slot, shared with the app's own panel. |
| "Phi Silica is not available on this device" | No NPU, an older Windows build, or it needs package identity. The app still works — the agent routes around it. |
| "Phi Silica needs to download its model first" | First use downloads it. `EnsureReadyAsync` is called automatically and can take minutes. |
| "Windows declined to summarize this text" | Content moderation. Normal, not a bug. |
| Build error about a missing targeting pack | `dotnet build -r win-x64` — the RID is required for WinUI. |
