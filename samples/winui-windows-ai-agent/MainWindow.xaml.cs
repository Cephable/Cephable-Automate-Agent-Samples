using System;
using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CephableDesk.Services;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics;
using Windows.Storage;
using Windows.Storage.Pickers;
using Windows.Storage.Streams;
using WinRT.Interop;
// `Windows.System` also defines DispatcherQueue, so the two `using`s would be ambiguous. Alias the
// only type we need from it instead.
using VirtualKey = Windows.System.VirtualKey;

namespace CephableDesk;

/// <summary>One line in the transcript. Bound directly by MainWindow.xaml.</summary>
public sealed class TranscriptEntry
{
    public TranscriptEntry(string label, string text, Brush accent, bool mono)
    {
        Label = label;
        Text = text;
        Accent = accent;
        IsMono = mono;
    }

    public string Label { get; }
    public string Text { get; }
    public Brush Accent { get; }
    public bool IsMono { get; }

    // Two TextBlocks in the template, one shown. A converter would be the idiomatic answer, but for a
    // single boolean it is more machinery than the thing it configures.
    public Visibility MonoVisibility => IsMono ? Visibility.Visible : Visibility.Collapsed;
    public Visibility ProseVisibility => IsMono ? Visibility.Collapsed : Visibility.Visible;
}

/// <summary>One of the three AI systems, shown as a status pill in the header.</summary>
public sealed class EnginePill
{
    public EnginePill(string name, string detail, Brush accent)
    {
        Name = name;
        Detail = detail;
        Accent = accent;
    }

    public string Name { get; }
    public string Detail { get; }
    public Brush Accent { get; }
}

public sealed partial class MainWindow : Window
{
    private readonly WindowsAiService _windowsAi = new();
    private readonly AgentTools _tools;
    private readonly ObservableCollection<TranscriptEntry> _transcript = new();
    private readonly ObservableCollection<EnginePill> _engines = new();
    private readonly DispatcherQueue _ui;

    private CephableClient? _cephable;
    private CancellationTokenSource? _running;

    public MainWindow()
    {
        InitializeComponent();
        _ui = DispatcherQueue.GetForCurrentThread();
        _tools = new AgentTools(_windowsAi);

        // Mica plus a custom title bar: the window reads as part of the shell rather than a box of
        // controls. Both degrade quietly on systems that cannot do them.
        SystemBackdrop = new MicaBackdrop();
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);

        SizeToDisplay();

        Transcript.ItemsSource = _transcript;
        NotesList.ItemsSource = _tools.Notes;
        StatusPills.ItemsSource = _engines;

        _tools.Notes.CollectionChanged += OnNotesChanged;

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

    /// <summary>
    /// Open at a readable size on any display. <c>AppWindow.Resize</c> takes physical pixels, so a
    /// fixed 1180x820 is cramped at 150% scale and a postage stamp on a 4K panel. Sizing from the
    /// work area sidesteps the scale factor entirely, because both numbers are already physical -
    /// and unlike the DPI, the work area is correct before the window is ever shown.
    /// </summary>
    private void SizeToDisplay()
    {
        DisplayArea display = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary);
        AppWindow.Resize(new SizeInt32(
            Math.Max(900, (int)(display.WorkArea.Width * 0.62)),
            Math.Max(640, (int)(display.WorkArea.Height * 0.80))));
    }

    // -- startup -------------------------------------------------------------

    private async Task InitializeAsync()
    {
        // Windows AI state first: it is local and instant, and it tells the user what this machine can
        // do before they try anything.
        WindowsAiService.Availability model = _windowsAi.CheckLanguageModel();
        WindowsAiService.Availability ocr = _windowsAi.CheckTextRecognizer();

        _engines.Add(new EnginePill("Cephable", "checking...", Accent("AccentIdleBrush")));
        _engines.Add(Engine("Phi Silica", model.Ready, model.Ready ? "on device" : "unavailable", "AccentWindowsBrush"));
        _engines.Add(Engine("Windows OCR", ocr.Ready, ocr.Ready ? "on device" : "unavailable", "AccentWindowsBrush"));

        string? token = Environment.GetEnvironmentVariable("CEPHABLE_AUTOMATE_KEY");
        if (string.IsNullOrWhiteSpace(token))
        {
            SetCephablePill("Cephable", "CEPHABLE_AUTOMATE_KEY is not set", ready: false);
            Add("app", "Set CEPHABLE_AUTOMATE_KEY to the access key from Cephable's Automate Server "
                     + "extension, then restart this app. The README has the steps.");
            RunButton.IsEnabled = false;
            return;
        }

        _cephable = new CephableClient(token, Environment.GetEnvironmentVariable("CEPHABLE_ENDPOINT"));

        try
        {
            CephableHealth health = await _cephable.GetHealthAsync();
            string accelerator = health.Backend?.Accelerator ?? "?";
            string fallback = health.Backend?.CpuFallback == true ? " - CPU fallback" : string.Empty;
            SetCephablePill(
                $"Cephable {health.AppVersion}",
                $"{health.ModelName} - {accelerator}{fallback}",
                ready: true);
        }
        catch (Exception error)
        {
            SetCephablePill("Cephable", "not reachable", ready: false);
            Add("app", Explain(error));
            RunButton.IsEnabled = false;
        }
    }

    private EnginePill Engine(string name, bool ready, string detail, string readyBrushKey) =>
        new(name, detail, Accent(ready ? readyBrushKey : "AccentIdleBrush"));

    private void SetCephablePill(string name, string detail, bool ready) =>
        _engines[0] = Engine(name, ready, detail, "AccentCephableBrush");

    // -- pasting an image ----------------------------------------------------

    /// <summary>
    /// Ctrl+V anywhere loads a document â€” except while the prompt box has focus, where the user
    /// plainly means to paste into the box. A window-scoped accelerator fires before the TextBox
    /// sees the key, so it has to decline explicitly.
    /// </summary>
    private void OnPasteAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        if (FocusManager.GetFocusedElement(Content.XamlRoot) == PromptBox) return;
        args.Handled = true;
        OnPasteClicked(sender, new RoutedEventArgs());
    }

    private async void OnPasteClicked(object sender, RoutedEventArgs e)
    {
        DataPackageView clipboard = Clipboard.GetContent();

        // Text first, and not just as a fallback: it needs no AI feature at all, so the Cephable half
        // of this sample works on every machine even when Windows AI refuses. An image-only entry
        // point made the whole app dead-end on any build where OCR is unavailable.
        if (clipboard.Contains(StandardDataFormats.Text))
        {
            UseText(await clipboard.GetTextAsync(), "clipboard text");
            return;
        }

        if (!clipboard.Contains(StandardDataFormats.Bitmap))
        {
            Add("app", "The clipboard has no text or image. Copy some text, or a screenshot (Win+Shift+S).");
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
        var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.DocumentsLibrary };
        foreach (string extension in new[] { ".txt", ".md", ".json", ".csv", ".log", ".png", ".jpg", ".jpeg", ".bmp" })
        {
            picker.FileTypeFilter.Add(extension);
        }

        // An unpackaged WinUI app has to hand the picker a window handle itself.
        InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(this));

        StorageFile? file = await picker.PickSingleFileAsync();
        if (file is not null) await LoadFileAsync(file.Path);
    }

    private void OnDragOver(object sender, DragEventArgs e) => e.AcceptedOperation = DataPackageOperation.Copy;

    private async void OnDrop(object sender, DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        var items = await e.DataView.GetStorageItemsAsync();
        if (items.Count > 0 && items[0] is StorageFile file) await LoadFileAsync(file.Path);
    }

    private static readonly string[] ImageExtensions = { ".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".gif" };

    private async Task LoadFileAsync(string path)
    {
        if (!ImageExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                UseText(await File.ReadAllTextAsync(path), Path.GetFileName(path));
            }
            catch (Exception error)
            {
                Add("app", $"Could not read {Path.GetFileName(path)}: {error.Message}");
            }
            return;
        }

        await ReadImageAsync(path);
    }

    private async Task ReadImageAsync(string path)
    {
        WindowsAiService.Availability ocr = _windowsAi.CheckTextRecognizer();
        if (!ocr.Ready)
        {
            Add("windows ocr", ocr.Detail);
            Add("app", "Nothing else here depends on OCR. Copy the text itself, or drop a .txt or .md "
                     + "file, and the Cephable agent works exactly the same.");
            return;
        }

        Add("windows ocr", "Reading the image on this device...");
        try
        {
            string text = await Task.Run(() => _windowsAi.ReadTextFromImageAsync(path));
            UseText(text, "Windows OCR");
        }
        catch (Exception error)
        {
            Add("windows ocr", error.Message);
        }
    }

    /// <summary>Hand a document to the agent, whatever produced it.</summary>
    private void UseText(string text, string source)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            Add("app", $"{source} had no text in it.");
            return;
        }

        _tools.ScreenText = text;
        ScreenTextPreview.Text = text;
        SourceLabel.Text = $"DOCUMENT Â· {source.ToUpperInvariant()}";
        Add("app", $"Loaded {text.Length:N0} characters from {source}. "
                 + "The agent can now use read_screen_text.");
    }

    // -- running the agent ---------------------------------------------------

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
            // Dropping the request cancels a run that is still working, but not one parked on our tools,
            // which keeps the slot until it times out. Stop it explicitly either way.
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

    // -- UI helpers ----------------------------------------------------------

    private void SetRunning(bool running)
    {
        // Run and Stop swap places rather than sitting side by side: only one of them is ever the
        // thing to press.
        RunButton.IsEnabled = !running && _cephable is not null;
        RunButton.Visibility = running ? Visibility.Collapsed : Visibility.Visible;
        StopButton.IsEnabled = running;
        StopButton.Visibility = running ? Visibility.Visible : Visibility.Collapsed;
        PromptBox.IsEnabled = !running;
        BusyRing.IsActive = running;
        BusyRing.Visibility = running ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnNotesChanged(object? sender, NotifyCollectionChangedEventArgs e) =>
        NotesEmptyHint.Visibility = _tools.Notes.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

    /// <summary>Append to the transcript from any thread.</summary>
    private void Add(string kind, string text) => _ui.TryEnqueue(() =>
    {
        (string label, string brushKey, bool mono) = kind switch
        {
            "you" => ("YOU", "AccentUserBrush", false),
            "cephable" => ("CEPHABLE", "AccentCephableBrush", false),
            "windows ocr" => ("WINDOWS OCR", "AccentWindowsBrush", false),
            "agent calls" => ("TOOL CALL", "AccentToolBrush", true),
            "tool result" => ("TOOL RESULT", "AccentToolBrush", true),
            "tool failed" => ("TOOL FAILED", "AccentDangerBrush", true),
            "run" => ("RUN", "AccentIdleBrush", true),
            _ => ("APP", "AccentIdleBrush", false),
        };

        _transcript.Add(new TranscriptEntry(label, text, Accent(brushKey), mono));
        TranscriptScroller.ChangeView(null, TranscriptScroller.ScrollableHeight + 400, null);
    });

    /// <summary>
    /// Resolves a theme brush by key. The brush is captured when the entry is created, so rows already
    /// in the transcript keep their colors if the system theme flips mid-session. Re-tinting history
    /// would mean INotifyPropertyChanged on every row for a case nobody watches.
    /// </summary>
    private static Brush Accent(string key) =>
        Application.Current.Resources.TryGetValue(key, out object? brush) && brush is Brush found
            ? found
            : new SolidColorBrush(Microsoft.UI.Colors.Gray);

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

