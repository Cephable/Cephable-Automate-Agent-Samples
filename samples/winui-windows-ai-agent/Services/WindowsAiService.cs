using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Graphics.Imaging;
using Microsoft.Windows.AI;
using Microsoft.Windows.AI.Imaging;
using Microsoft.Windows.AI.Text;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace CephableDesk.Services;

/// <summary>
/// Windows' own on-device AI: OCR via <see cref="TextRecognizer"/>, and text intelligence via Phi
/// Silica (<see cref="LanguageModel"/> plus <see cref="TextSummarizer"/> / <see cref="TextRewriter"/>).
///
/// Both are separate from Cephable and complementary to it. Windows is very good at the narrow,
/// fast jobs — read the text out of this image, tighten this paragraph — and it needs no prompt and no
/// tools. Cephable is the agent: it decides what to do, calls these as tools, and chains the results
/// into real work. Neither one touches a network.
///
/// Everything here is availability-checked. These features need a recent Windows build and, for Phi
/// Silica, a Copilot+ PC with an NPU. On a machine without them the app still runs and still uses
/// Cephable — the Windows-specific tools simply report that they are unavailable, which the agent
/// reads and works around.
/// </summary>
public sealed class WindowsAiService : IDisposable
{
    private LanguageModel? _model;
    private TextRecognizer? _recognizer;

    /// <summary>Why a feature is not usable, phrased for the agent rather than for a log.</summary>
    public sealed record Availability(bool Ready, string Detail);

    // ── Phi Silica ───────────────────────────────────────────────────────────

    public Availability CheckLanguageModel()
    {
        try
        {
            return Describe(LanguageModel.GetReadyState(), "Phi Silica");
        }
        catch (Exception error)
        {
            // A machine or Windows build without the feature at all throws rather than returning a
            // state. Treat that as "not available here" instead of failing the app.
            return new Availability(false, $"Phi Silica is not available on this device ({error.GetType().Name}).");
        }
    }

    public Availability CheckTextRecognizer()
    {
        try
        {
            return Describe(TextRecognizer.GetReadyState(), "Windows OCR");
        }
        catch (Exception error)
        {
            return new Availability(false, $"Windows OCR is not available on this device ({error.GetType().Name}).");
        }
    }

    private static Availability Describe(AIFeatureReadyState state, string feature) => state switch
    {
        AIFeatureReadyState.Ready => new Availability(true, $"{feature} is ready."),
        AIFeatureReadyState.NotReady => new Availability(false, $"{feature} needs to download its model first."),
        AIFeatureReadyState.DisabledByUser => new Availability(false, $"{feature} is disabled in Windows settings."),
        _ => new Availability(false, $"{feature} is not supported on this device."),
    };

    /// <summary>
    /// Get the shared model, downloading it on first use.
    /// </summary>
    /// <remarks>
    /// <see cref="LanguageModel.EnsureReadyAsync"/> can take minutes the first time, so this is called
    /// from the tool handlers rather than at startup — an app that blocks its own launch on a model
    /// download is a worse app, and the user may never use these features.
    /// </remarks>
    private async Task<LanguageModel> GetModelAsync()
    {
        if (_model is not null) return _model;

        if (LanguageModel.GetReadyState() == AIFeatureReadyState.NotReady)
        {
            AIFeatureReadyResult result = await LanguageModel.EnsureReadyAsync();
            if (result.Status != AIFeatureReadyResultState.Success)
            {
                throw new InvalidOperationException($"Phi Silica could not be prepared: {result.Status}.");
            }
        }

        _model = await LanguageModel.CreateAsync();
        return _model;
    }

    private async Task<TextRecognizer> GetRecognizerAsync()
    {
        if (_recognizer is not null) return _recognizer;

        if (TextRecognizer.GetReadyState() == AIFeatureReadyState.NotReady)
        {
            AIFeatureReadyResult result = await TextRecognizer.EnsureReadyAsync();
            if (result.Status != AIFeatureReadyResultState.Success)
            {
                throw new InvalidOperationException($"Windows OCR could not be prepared: {result.Status}.");
            }
        }

        _recognizer = await TextRecognizer.CreateAsync();
        return _recognizer;
    }

    /// <summary>Summarize text with Phi Silica, entirely on this device.</summary>
    public async Task<string> SummarizeAsync(string text)
    {
        LanguageModel model = await GetModelAsync();
        var summarizer = new TextSummarizer(model);
        LanguageModelResponseResult result = await summarizer.SummarizeAsync(text);
        return Unwrap(result, "summarize");
    }

    /// <summary>Rewrite text with Phi Silica, entirely on this device.</summary>
    public async Task<string> RewriteAsync(string text)
    {
        LanguageModel model = await GetModelAsync();
        var rewriter = new TextRewriter(model);
        LanguageModelResponseResult result = await rewriter.RewriteAsync(text);
        return Unwrap(result, "rewrite");
    }

    /// <summary>
    /// Turn a response into text, or an exception the agent can read.
    /// </summary>
    /// <remarks>
    /// Content moderation is a normal outcome here, not a bug: Phi Silica refuses some input and some
    /// output. Saying so plainly lets the agent explain the refusal to the user instead of reporting a
    /// blank result.
    /// </remarks>
    private static string Unwrap(LanguageModelResponseResult result, string operation) => result.Status switch
    {
        LanguageModelResponseStatus.Complete => result.Text,
        LanguageModelResponseStatus.PromptBlockedByContentModeration =>
            throw new InvalidOperationException($"Windows declined to {operation} this text: its content filter blocked the input."),
        LanguageModelResponseStatus.ResponseBlockedByContentModeration =>
            throw new InvalidOperationException($"Windows produced a {operation} result but its content filter blocked the output."),
        LanguageModelResponseStatus.PromptLargerThanContext =>
            throw new InvalidOperationException($"The text is too long for Phi Silica to {operation} in one pass. Pass a shorter excerpt."),
        _ => throw new InvalidOperationException($"Phi Silica could not {operation} the text: {result.Status}."),
    };

    // ── OCR ──────────────────────────────────────────────────────────────────

    /// <summary>
    /// Read the text out of an image file with Windows' on-device OCR.
    /// </summary>
    /// <remarks>
    /// Lines are joined in the order the recognizer returns them, which is reading order for ordinary
    /// screenshots and documents. Good enough for an error dialog or a receipt; a form with columns
    /// would want the per-line bounding boxes, which <c>RecognizedLine</c> also exposes.
    /// </remarks>
    public async Task<string> ReadTextFromImageAsync(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"No such image: {path}");

        TextRecognizer recognizer = await GetRecognizerAsync();

        using IRandomAccessStream stream = await Windows.Storage.StorageFile
            .GetFileFromPathAsync(Path.GetFullPath(path))
            .AsTask()
            .ContinueWith(task => task.Result.OpenAsync(Windows.Storage.FileAccessMode.Read).AsTask())
            .Unwrap();

        BitmapDecoder decoder = await BitmapDecoder.CreateAsync(stream);
        using SoftwareBitmap bitmap = await decoder.GetSoftwareBitmapAsync();

        ImageBuffer buffer = ImageBuffer.CreateForSoftwareBitmap(bitmap);
        RecognizedText recognized = recognizer.RecognizeTextFromImage(buffer);

        string[] lines = recognized.Lines.Select(line => line.Text).ToArray();
        if (lines.Length == 0) throw new InvalidOperationException("Windows OCR found no text in that image.");

        return string.Join(Environment.NewLine, lines);
    }

    public void Dispose()
    {
        _model?.Dispose();
        _recognizer?.Dispose();
    }
}
