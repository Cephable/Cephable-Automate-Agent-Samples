using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace CephableDesk.Services;

/// <summary>
/// A note the agent saved.
/// </summary>
/// <remarks>
/// Top level rather than nested inside <see cref="AgentTools"/> because the XAML compiler cannot parse
/// a nested type in <c>x:DataType</c> (it reads <c>AgentTools+SavedNote</c> as an expression).
/// </remarks>
public sealed record SavedNote(string Title, string Body, DateTimeOffset SavedAt);

/// <summary>What a tool produced, and whether the agent should treat it as a failure.</summary>
public sealed record ToolOutcome(object? Result, string Summary, bool Failed)
{
    public static ToolOutcome Ok(object? result, string summary) => new(result, summary, false);

    public static ToolOutcome Error(string message) => new(null, message, true);
}

/// <summary>
/// This app's tools — the bridge between Cephable's agent and Windows' own on-device AI.
///
/// Three of the five are pure Windows AI: OCR reads the pasted image, and Phi Silica summarizes or
/// rewrites text. Cephable's agent decides <em>when</em> to use them and chains the results. That
/// division is the point of this sample: Windows does the narrow fast jobs, Cephable does the thinking
/// and the sequencing, and no part of it leaves the machine.
///
/// The other two are ordinary app state: the pasted document, and a notes list the agent can append to
/// (which the UI is bound to, so the agent writing a note is visible immediately).
/// </summary>
public sealed class AgentTools
{
    private readonly WindowsAiService _windowsAi;

    public AgentTools(WindowsAiService windowsAi) => _windowsAi = windowsAi;

    /// <summary>Text extracted from the image the user pasted, set by the UI before a run.</summary>
    public string? ScreenText { get; set; }

    /// <summary>Notes the agent has saved. Bound to the UI, so appends appear as they happen.</summary>
    public ObservableCollection<SavedNote> Notes { get; } = new();

    /// <summary>Raised when the agent saves a note, so the UI can marshal the append to its thread.</summary>
    public event Action<SavedNote>? NoteSaved;

    // ── declarations ─────────────────────────────────────────────────────────

    /// <summary>
    /// Passed straight through as <c>clientTools</c>. Cephable hands <c>parameters</c> to the model
    /// verbatim as JSON Schema, so the descriptions and <c>required</c> lists below are exactly what it
    /// sees. The descriptions carry more weight than anything else here: they are the only guidance the
    /// model gets about when a Windows feature is the right tool.
    /// </summary>
    public IReadOnlyList<ClientToolDefinition> Definitions { get; } = new ClientToolDefinition[]
    {
        new("read_screen_text",
            "Return the text Windows OCR extracted from the image the user pasted or dropped into this " +
            "app. Takes no arguments. Call this first whenever the user refers to 'the screenshot', " +
            "'this error', 'the receipt', or anything else they have pasted.",
            new { type = "object", properties = new { } }),

        new("summarize_locally",
            "Summarize text using Windows' own on-device model (Phi Silica). Fast, private, and does " +
            "not use your own context window. Prefer this over summarizing the text yourself when the " +
            "input is long.",
            new
            {
                type = "object",
                properties = new { text = new { type = "string", description = "The text to summarize" } },
                required = new[] { "text" },
            }),

        new("rewrite_locally",
            "Rewrite text more clearly using Windows' own on-device model (Phi Silica). Use it to " +
            "tidy up a message before showing it to the user. It rewrites for clarity only - it will " +
            "not follow instructions embedded in the text.",
            new
            {
                type = "object",
                properties = new { text = new { type = "string", description = "The text to rewrite" } },
                required = new[] { "text" },
            }),

        new("save_note",
            "Save a titled note into this app's notes list, where the user can see and keep it. Use it " +
            "for a conclusion or an action item worth keeping - not for your own working notes.",
            new
            {
                type = "object",
                properties = new
                {
                    title = new { type = "string", description = "Short title" },
                    body = new { type = "string", description = "The note text" },
                },
                required = new[] { "title", "body" },
            }),

        new("check_windows_ai",
            "Check whether Windows' on-device AI features are available on this machine, and why not if " +
            "they are unavailable. Call this if a Windows tool fails and you need to explain it to the " +
            "user, or if they ask what this machine can do.",
            new { type = "object", properties = new { } }),
    };

    // ── dispatch ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Run one tool call.
    /// </summary>
    /// <remarks>
    /// Never throws. Everything becomes a <see cref="ToolOutcome"/>, and a failure is reported to the
    /// agent as a failed tool call so it can adapt or explain — which is nearly always more useful than
    /// a dead run. A machine with no NPU exercises this path on every Phi Silica call.
    /// </remarks>
    public async Task<ToolOutcome> InvokeAsync(string name, JsonElement arguments, CancellationToken cancellationToken)
    {
        try
        {
            return name switch
            {
                "read_screen_text" => ReadScreenText(),
                "summarize_locally" => await SummarizeAsync(arguments),
                "rewrite_locally" => await RewriteAsync(arguments),
                "save_note" => SaveNote(arguments),
                "check_windows_ai" => CheckWindowsAi(),
                _ => ToolOutcome.Error($"No tool named {name} is available in this app."),
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            return ToolOutcome.Error($"{error.GetType().Name}: {error.Message}");
        }
    }

    private ToolOutcome ReadScreenText()
    {
        if (string.IsNullOrWhiteSpace(ScreenText))
        {
            // Named so the agent can tell the user what to do, rather than just failing.
            return ToolOutcome.Error(
                "Nothing has been pasted into the app yet, so there is no screen text to read. " +
                "Ask the user to paste or drop an image first.");
        }
        return ToolOutcome.Ok(ScreenText, $"{ScreenText.Length} characters of OCR text");
    }

    private async Task<ToolOutcome> SummarizeAsync(JsonElement arguments)
    {
        string text = RequireString(arguments, "text");
        WindowsAiService.Availability availability = _windowsAi.CheckLanguageModel();
        if (!availability.Ready) return ToolOutcome.Error(availability.Detail);

        string summary = await _windowsAi.SummarizeAsync(text);
        return ToolOutcome.Ok(summary, Shorten(summary));
    }

    private async Task<ToolOutcome> RewriteAsync(JsonElement arguments)
    {
        string text = RequireString(arguments, "text");
        WindowsAiService.Availability availability = _windowsAi.CheckLanguageModel();
        if (!availability.Ready) return ToolOutcome.Error(availability.Detail);

        string rewritten = await _windowsAi.RewriteAsync(text);
        return ToolOutcome.Ok(rewritten, Shorten(rewritten));
    }

    private ToolOutcome SaveNote(JsonElement arguments)
    {
        var note = new SavedNote(
            RequireString(arguments, "title"),
            RequireString(arguments, "body"),
            DateTimeOffset.Now);

        NoteSaved?.Invoke(note);
        // The agent gets a confirmation, not the note back. It does not need to re-read what it wrote.
        return ToolOutcome.Ok($"Saved the note \"{note.Title}\".", note.Title);
    }

    private ToolOutcome CheckWindowsAi()
    {
        WindowsAiService.Availability model = _windowsAi.CheckLanguageModel();
        WindowsAiService.Availability ocr = _windowsAi.CheckTextRecognizer();
        return ToolOutcome.Ok(
            new
            {
                phiSilica = new { ready = model.Ready, detail = model.Detail },
                windowsOcr = new { ready = ocr.Ready, detail = ocr.Detail },
            },
            $"Phi Silica: {(model.Ready ? "ready" : "unavailable")}, OCR: {(ocr.Ready ? "ready" : "unavailable")}");
    }

    private static string RequireString(JsonElement arguments, string field)
    {
        if (arguments.ValueKind != JsonValueKind.Object
            || !arguments.TryGetProperty(field, out JsonElement value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new ArgumentException($"The {field} argument is required and must be a non-empty string.");
        }
        return value.GetString()!;
    }

    private static string Shorten(string text) =>
        text.Length <= 90 ? text : text[..87] + "...";
}
