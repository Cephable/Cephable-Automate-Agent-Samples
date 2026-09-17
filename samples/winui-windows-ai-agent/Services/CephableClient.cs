using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace CephableDesk.Services;

// ── wire types ───────────────────────────────────────────────────────────────

public sealed record CephableBackend(
    [property: JsonPropertyName("accelerator")] string Accelerator,
    [property: JsonPropertyName("cpuFallback")] bool CpuFallback);

public sealed record CephableHealth(
    [property: JsonPropertyName("service")] string Service,
    [property: JsonPropertyName("appVersion")] string AppVersion,
    [property: JsonPropertyName("workflowStatus")] string WorkflowStatus,
    [property: JsonPropertyName("busy")] bool Busy,
    [property: JsonPropertyName("modelName")] string? ModelName,
    [property: JsonPropertyName("contextSize")] int? ContextSize,
    [property: JsonPropertyName("backend")] CephableBackend? Backend)
{
    public bool IsReady => !Busy && WorkflowStatus is "idle" or "terminated";
}

public sealed record CephableToolCall(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("arguments")] JsonElement Arguments);

public sealed record CephableStep(
    [property: JsonPropertyName("index")] int Index,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("toolName")] string? ToolName);

public sealed record CephableUsage(
    [property: JsonPropertyName("inputTokens")] int InputTokens,
    [property: JsonPropertyName("outputTokens")] int OutputTokens,
    [property: JsonPropertyName("tps")] double Tps);

public sealed record CephableRunRecord(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("requestId")] string RequestId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("answer")] string Answer,
    [property: JsonPropertyName("finalAnswer")] string? FinalAnswer,
    [property: JsonPropertyName("errorCode")] string? ErrorCode,
    [property: JsonPropertyName("durationMs")] long DurationMs,
    [property: JsonPropertyName("model")] string? Model,
    [property: JsonPropertyName("backend")] CephableBackend? Backend,
    [property: JsonPropertyName("steps")] IReadOnlyList<CephableStep>? Steps,
    [property: JsonPropertyName("usage")] CephableUsage? Usage,
    [property: JsonPropertyName("toolCalls")] IReadOnlyList<CephableToolCall>? ToolCalls,
    [property: JsonPropertyName("resumeToken")] string? ResumeToken)
{
    public bool Completed => Status == "completed";
    public bool AwaitingToolResults => Status == "awaiting_tool_results";
    public string Value => string.IsNullOrWhiteSpace(FinalAnswer) ? Answer : FinalAnswer!;
}

public sealed record ClientToolDefinition(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("description")] string Description,
    [property: JsonPropertyName("parameters")] object? Parameters);

/// <summary>The request never produced a run: 400, 401, 404, 409.</summary>
public sealed class CephableRequestException : Exception
{
    public CephableRequestException(string message, int status) : base(message) => Status = status;

    public int Status { get; }

    /// <summary>409 - a run is already going, possibly one the user started in the Cephable app.</summary>
    public bool IsBusy => Status == 409;

    public bool IsUnauthorized => Status == 401;
}

// ── client ───────────────────────────────────────────────────────────────────

/// <summary>
/// Client for the local Cephable Automate HTTP Server.
///
/// Handles the three things every Cephable client has to: finding the port (it moves), telling a failed
/// <em>run</em> from a failed <em>request</em>, and driving the park/resume loop when the agent calls a
/// tool this app owns.
/// </summary>
public sealed class CephableClient : IDisposable
{
    private const int DefaultPort = 4317;
    private const int PortAttempts = 12;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _http;
    private readonly string _token;
    private string? _endpoint;

    public CephableClient(string token, string? endpoint = null)
    {
        _token = token;
        _endpoint = endpoint;
        // No client-wide timeout: agent runs are long, and each call sets its own deadline with a
        // CancellationToken. A client that gives up does not stop the run - it keeps going in Cephable.
        _http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        _http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    }

    public string? Endpoint => _endpoint;

    /// <summary>
    /// Find the server, confirming it really is Cephable.
    /// </summary>
    /// <remarks>
    /// Cephable binds 4317 when it can and the next free port when it cannot, so a hardcoded endpoint
    /// silently breaks. Checking <c>service</c> matters because OpenTelemetry collectors also default
    /// to 4317, and pointing an agent client at one produces baffling errors.
    /// </remarks>
    public async Task<string> ResolveEndpointAsync(CancellationToken cancellationToken = default)
    {
        if (_endpoint is not null) return _endpoint;

        for (int offset = 0; offset < PortAttempts; offset++)
        {
            string candidate = $"http://127.0.0.1:{DefaultPort + offset}";
            try
            {
                using var probe = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                probe.CancelAfter(TimeSpan.FromSeconds(3));

                using HttpResponseMessage response = await _http.GetAsync($"{candidate}/health", probe.Token);
                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    throw new CephableRequestException(
                        $"Cephable is listening on {candidate} but rejected the access key. It may have been regenerated.",
                        401);
                }
                if (!response.IsSuccessStatusCode) continue;

                CephableHealth? health = await response.Content.ReadFromJsonAsync<CephableHealth>(Json, probe.Token);
                if (health?.Service == "cephable-agent")
                {
                    _endpoint = candidate;
                    return candidate;
                }
            }
            catch (CephableRequestException) { throw; }
            catch (HttpRequestException) { /* nothing listening here */ }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { /* probe timeout */ }
        }

        throw new CephableRequestException(
            $"No Cephable server answered on 127.0.0.1:{DefaultPort}-{DefaultPort + PortAttempts - 1}. " +
            "Open Cephable and enable Extensions > Cephable features > Build & Extend > Automate HTTP Server.",
            503);
    }

    private async Task<T> SendAsync<T>(
        HttpMethod method,
        string route,
        object? payload,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        string endpoint = await ResolveEndpointAsync(cancellationToken);

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);

        using var request = new HttpRequestMessage(method, $"{endpoint}{route}");
        if (payload is not null) request.Content = JsonContent.Create(payload, options: Json);

        using HttpResponseMessage response = await _http.SendAsync(request, deadline.Token);
        string body = await response.Content.ReadAsStringAsync(deadline.Token);

        using JsonDocument document = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
        JsonElement root = document.RootElement;

        // A failed run is HTTP 500 carrying a COMPLETE record. Only a body without schemaVersion means
        // the request never started one - this check is what separates the two.
        bool hasRecord = root.TryGetProperty("schemaVersion", out JsonElement version)
            && version.ValueKind == JsonValueKind.Number
            && version.GetInt32() == 1;

        if (!response.IsSuccessStatusCode && !hasRecord)
        {
            string message = $"{route} returned HTTP {(int)response.StatusCode}";
            if (root.TryGetProperty("error", out JsonElement error)
                && error.TryGetProperty("message", out JsonElement detail))
            {
                message = detail.GetString() ?? message;
            }
            throw new CephableRequestException(message, (int)response.StatusCode);
        }

        return JsonSerializer.Deserialize<T>(body, Json)
            ?? throw new CephableRequestException($"{route} returned an empty body", (int)response.StatusCode);
    }

    public Task<CephableHealth> GetHealthAsync(CancellationToken cancellationToken = default) =>
        SendAsync<CephableHealth>(HttpMethod.Get, "/health", null, TimeSpan.FromSeconds(10), cancellationToken);

    /// <summary>Wait for the single inference slot, which is shared with the Cephable app's own panel.</summary>
    public async Task<CephableHealth> WaitUntilReadyAsync(
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        DateTimeOffset deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromMinutes(2));
        CephableHealth? last = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            last = await GetHealthAsync(cancellationToken);
            if (last.IsReady) return last;
            await Task.Delay(1000, cancellationToken);
        }
        throw new CephableRequestException(
            $"Cephable stayed busy (last status: {last?.WorkflowStatus ?? "unknown"}).", 409);
    }

    public Task<CephableRunRecord> StartRunAsync(
        string prompt,
        IReadOnlyList<ClientToolDefinition> clientTools,
        int timeoutMs = 300_000,
        CancellationToken cancellationToken = default) =>
        SendAsync<CephableRunRecord>(
            HttpMethod.Post,
            "/v1/runs",
            new
            {
                prompt,
                timeoutMs,
                clientTools,
                // This app's tools are its own in-memory state plus Windows AI, so the agent has no
                // reason to reach the filesystem. Narrow by default.
                restrictToWorkspace = true,
                allowDestructiveTools = false,
                include = new { steps = true, trace = false, events = false },
            },
            // Above the server's own deadline, so its timeout wins rather than us abandoning a live run.
            TimeSpan.FromMilliseconds(timeoutMs + 15_000),
            cancellationToken);

    public Task<CephableRunRecord> ResumeRunAsync(
        string resumeToken,
        IReadOnlyList<object> results,
        CancellationToken cancellationToken = default) =>
        SendAsync<CephableRunRecord>(
            HttpMethod.Post,
            $"/v1/runs/{Uri.EscapeDataString(resumeToken)}/tool-results",
            new { results },
            // The server gives a parked run two minutes per round before it self-cancels.
            TimeSpan.FromSeconds(135),
            cancellationToken);

    /// <summary>Always safe to call, even when nothing is running. Use it on your error path.</summary>
    public Task<JsonElement> CancelAsync(bool force = false, CancellationToken cancellationToken = default) =>
        SendAsync<JsonElement>(
            HttpMethod.Post, "/v1/automate/cancel", new { force }, TimeSpan.FromSeconds(30), cancellationToken);

    /// <summary>
    /// Run a task, driving the park/resume loop to completion.
    /// </summary>
    /// <param name="onEvent">
    /// Called for each observable moment so the UI can show the run as it happens: a tool call, its
    /// result, and the final answer. Marshalling to the UI thread is the caller's job.
    /// </param>
    public async Task<CephableRunRecord> RunWithToolsAsync(
        string prompt,
        AgentTools tools,
        Action<AgentEvent> onEvent,
        int maxRounds = 20,
        CancellationToken cancellationToken = default)
    {
        CephableRunRecord record = await StartRunAsync(prompt, tools.Definitions, cancellationToken: cancellationToken);

        int rounds = 0;
        while (record.AwaitingToolResults)
        {
            if (++rounds > maxRounds)
            {
                // A model looping on one tool would otherwise hold the machine's only inference slot
                // until the run's own timeout expires.
                await CancelAsync(force: true, CancellationToken.None);
                throw new CephableRequestException(
                    $"The agent asked for tools {maxRounds} times without settling. Run cancelled.", 500);
            }

            var results = new List<object>();
            foreach (CephableToolCall call in record.ToolCalls ?? Array.Empty<CephableToolCall>())
            {
                onEvent(new AgentEvent.ToolCall(call.Name, call.Arguments));

                ToolOutcome outcome = await tools.InvokeAsync(call.Name, call.Arguments, cancellationToken);
                onEvent(new AgentEvent.ToolResult(call.Name, outcome.Summary, outcome.Failed));

                results.Add(outcome.Failed
                    ? new { id = call.Id, error = outcome.Summary }
                    : new { id = call.Id, result = outcome.Result });
            }

            record = await ResumeRunAsync(record.ResumeToken!, results, cancellationToken);
        }

        onEvent(new AgentEvent.Answer(record.Value, record));
        return record;
    }

    public void Dispose() => _http.Dispose();
}

/// <summary>Something worth showing the user as the run progresses.</summary>
public abstract record AgentEvent
{
    public sealed record ToolCall(string Name, JsonElement Arguments) : AgentEvent;

    public sealed record ToolResult(string Name, string Summary, bool Failed) : AgentEvent;

    public sealed record Answer(string Text, CephableRunRecord Record) : AgentEvent;
}
