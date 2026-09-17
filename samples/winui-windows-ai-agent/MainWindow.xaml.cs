using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using CephableDesk.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Pickers;
using Windows.Storage.Streams;
using WinRT.Interop;
// `Windows.System` also defines DispatcherQueue, so the two `using`s would be ambiguous. Alias the
// only type we need from it instead.
using VirtualKey = Windows.System.VirtualKey;

namespace CephableDesk;

/// <summary>One line in the transcript. Bound directly by MainWindow.xaml.</summary>
public sealed record TranscriptEntry(string Kind, string Text);

public sealed partial class MainWindow : Window
{
    private readonly WindowsAiService _windowsAi = new();
    private readonly AgentTools _tools;
    private readonly ObservableCollection<TranscriptEntry> _transcript = new();
    private readonly DispatcherQueue _ui;

    private CephableClient? _cephable;
    private CancellationTokenSource? _running;

    public MainWindow()
    {
        InitializeComponent();
        _ui = DispatcherQueue.GetForCurrentThread();
        _tools = new AgentTools(_windowsAi);

        Transcript.ItemsSource = _transcript;
        NotesList.ItemsSource = _tools.Notes;

        // The agent saves notes from a worker thread; the collection is bound to the UI, so the append
        // has to be marshalled.
        _tools.NoteSaved += note => _ui.TryEnqueue(() => _tools.Notes.Insert(0, note));

        Closed += (_, _) =>
        {
            _running?.Cancel();
            _cephable?.Dispose();
            _windowsAi.Dispose();
        };

        _ = InitializeAsync();
    }

    // ── startup ──────────────────────────────────────────────────────────────

    private async Task InitializeAsync()
    {
        // Windows AI state first: it is local and instant, and it tells the user what this machine can
        // do before they try anything.
        WindowsAiService.Availability model = _windowsAi.CheckLanguageModel();
        WindowsAiService.Availability ocr = _windowsAi.CheckTextRecognizer();
        WindowsAiStatus.Text = $"Phi Silica: {(model.Ready ? "ready" : "unavailable")}  |  "
                             + $"Windows OCR: {(ocr.Ready ? "ready" : "unavailable")}";

        string? token = Environment.GetEnvironmentVariable("CEPHABLE_AUTOMATE_KEY");
        if (string.IsNullOrWhiteSpace(token))
        {
            CephableStatus.Text = "CEPHABLE_AUTOMATE_KEY is not set - see the README";
            RunButton.IsEnabled = false;
            return;
        }

        _cephable = new CephableClient(token, Environment.GetEnvironmentVariable("CEPHABLE_ENDPOINT"));

        try
        {
            CephableHealth health = await _cephable.GetHealthAsync();
            string accelerator = health.Backend?.Accelerator ?? "?";
            string fallback = health.Backend?.CpuFallback == true ? " (CPU fallback)" : string.Empty;
            CephableStatus.Text = $"Cephable {health.AppVersion} at {_cephable.Endpoint}  |  "
                                + $"{health.ModelName}  |  {accelerator}{fallback}";
        }
        catch (Exception error)
        {
            CephableStatus.Text = Explain(error);
            RunButton.IsEnabled = false;
        }
    }

    // ── pasting an image ─────────────────────────────────────────────────────

    private async void OnPasteClicked(object sender, RoutedEventArgs e)
    {
        DataPackageView clipboard = Clipboard.GetContent();
        if (!clipboard.Contains(StandardDataFormats.Bitmap))
        {
            Add("app", "The clipboard does not contain an image. Copy a screenshot first (Win+Shift+S).");
            return;
        }

        RandomAccessStreamReference reference = await clipboard.GetBitmapAsync();
        using IRandomAccessStreamWithContentType stream = await reference.OpenReadAsync();

        // Windows OCR takes a file or a bitmap; the clipboard gives us a stream, so it lands in temp
        // first. Deleted immediately afterwards - a pasted screenshot can contain anything.
        string path = Path.Combine(Path.GetTempPath(), $"cephable-desk-{Guid.NewGuid():N}.png");
        using (FileStream file = File.Create(path))
        using (Stream managed = stream.AsStreamForRead())
        {
            await managed.CopyToAsync(file);
        }

        try
        {
            await ReadImageAsync(path);
        }
        finally
        {
            try { File.Delete(path); } catch { /* best effort */ }
        }
    }

    private async void OnOpenClicked(object sender, RoutedEventArgs e)
    {
        var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.PicturesLibrary };
        picker.FileTypeFilter.Add(".png");
        picker.FileTypeFilter.Add(".jpg");
        picker.FileTypeFilter.Add(".jpeg");
        picker.FileTypeFilter.Add(".bmp");

        // An unpackaged WinUI app has to hand the picker a window handle itself.
        InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(this));

        StorageFile? file = await picker.PickSingleFileAsync();
        if (file is not null) await ReadImageAsync(file.Path);
    }

    private void OnDragOver(object sender, DragEventArgs e) => e.AcceptedOperation = DataPackageOperation.Copy;

    private async void OnDrop(object sender, DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        var items = await e.DataView.GetStorageItemsAsync();
        if (items.Count > 0 && items[0] is StorageFile file) await ReadImageAsync(file.Path);
    }

    private async Task ReadImageAsync(string path)
    {
        WindowsAiService.Availability ocr = _windowsAi.CheckTextRecognizer();
        if (!ocr.Ready)
        {
            Add("windows ocr", ocr.Detail);
            return;
        }

        Add("windows ocr", "Reading the image on this device...");
        try
        {
            string text = await Task.Run(() => _windowsAi.ReadTextFromImageAsync(path));
            _tools.ScreenText = text;
            ScreenTextPreview.Text = text;
            Add("windows ocr", $"Read {text.Length} characters. The agent can now use read_screen_text.");
        }
        catch (Exception error)
        {
            Add("windows ocr", error.Message);
        }
    }

    // ── running the agent ────────────────────────────────────────────────────

    private void OnPromptKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter && RunButton.IsEnabled) OnRunClicked(sender, e);
    }

    private async void OnRunClicked(object sender, RoutedEventArgs e)
    {
        if (_cephable is null || _running is not null) return;

        string prompt = PromptBox.Text.Trim();
        if (prompt.Length == 0) return;

        PromptBox.Text = string.Empty;
        Add("you", prompt);
        SetRunning(true);
        _running = new CancellationTokenSource();

        try
        {
            // One inference slot, shared with Cephable's own AI Workflows panel, so wait rather than
            // firing into a 409.
            Add("app", "Waiting for the assistant to be free...");
            await _cephable.WaitUntilReadyAsync(TimeSpan.FromMinutes(1), _running.Token);

            CephableRunRecord record = await _cephable.RunWithToolsAsync(
                prompt,
                _tools,
                OnAgentEvent,
                cancellationToken: _running.Token);

            if (!record.Completed)
            {
                Add("app", $"The run ended {record.Status}"
                         + (record.ErrorCode is null ? "." : $" ({record.ErrorCode})."));
            }

            CephableUsage? usage = record.Usage;
            Add("run", $"{record.Steps?.Count ?? 0} steps | {record.DurationMs / 1000.0:F1}s"
                     + (usage is null ? string.Empty : $" | {usage.OutputTokens} tokens out")
                     + (record.Model is null ? string.Empty : $" | {record.Model}"));
        }
        catch (OperationCanceledException)
        {
            // Cancelling our own task does not stop the run - it keeps going inside Cephable and holds
            // the slot. Stop it there too.
            await SafeCancelAsync();
            Add("app", "Stopped.");
        }
        catch (Exception error)
        {
            await SafeCancelAsync();
            Add("app", Explain(error));
        }
        finally
        {
            _running?.Dispose();
            _running = null;
            SetRunning(false);
        }
    }

    private async void OnStopClicked(object sender, RoutedEventArgs e)
    {
        StopButton.IsEnabled = false;
        // Stop the run in Cephable first, then abandon our own wait.
        await SafeCancelAsync();
        _running?.Cancel();
    }

    private async Task SafeCancelAsync()
    {
        if (_cephable is null) return;
        try { await _cephable.CancelAsync(force: false, CancellationToken.None); }
        catch { /* cancel is best-effort; never let it mask the original failure */ }
    }

    /// <summary>Called from the run's worker thread for each observable moment.</summary>
    private void OnAgentEvent(AgentEvent agentEvent)
    {
        switch (agentEvent)
        {
            case AgentEvent.ToolCall call:
                Add("agent calls", $"{call.Name}({Compact(call.Arguments.ToString())})");
                break;
            case AgentEvent.ToolResult result:
                Add(result.Failed ? "tool failed" : "tool result", result.Summary);
                break;
            case AgentEvent.Answer answer:
                Add("cephable", answer.Text);
                break;
        }
    }

    // ── UI helpers ───────────────────────────────────────────────────────────

    private void SetRunning(bool running)
    {
        RunButton.IsEnabled = !running && _cephable is not null;
        StopButton.IsEnabled = running;
        PromptBox.IsEnabled = !running;
    }

    /// <summary>Append to the transcript from any thread.</summary>
    private void Add(string kind, string text) => _ui.TryEnqueue(() =>
    {
        _transcript.Add(new TranscriptEntry(kind, text));
        TranscriptScroller.ChangeView(null, TranscriptScroller.ScrollableHeight + 400, null);
    });

    private static string Compact(string json) =>
        json.Length <= 120 ? json.Replace("\r", " ").Replace("\n", " ") : json[..117] + "...";

    private static string Explain(Exception error) => error switch
    {
        CephableRequestException { IsBusy: true } =>
            "Cephable is busy with another run. It has one inference slot, shared with the app's own "
            + "AI Workflows panel - wait for that to finish, or stop it in Cephable.",
        CephableRequestException { IsUnauthorized: true } =>
            "Cephable rejected the access key. Copy it again from the extension detail view - "
            + "regenerating it invalidates the old one immediately.",
        CephableRequestException request => request.Message,
        _ => $"{error.GetType().Name}: {error.Message}",
    };
}
