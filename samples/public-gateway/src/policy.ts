/**
 * The request policy — the part of this sample that actually matters.
 *
 * Cephable's local API trusts its caller completely, and correctly so: it is bound to loopback, and
 * whoever holds the access key is assumed to be the person sitting at the machine. The moment you put
 * that behind a public address, *you* become the thing standing between the internet and someone's
 * computer. This module is that thing.
 *
 * The rule it follows: a remote caller may ask the agent to *think*, and may give it *its own* tools.
 * It may not ask the agent to reach into the host machine.
 */

/** A remote caller, resolved from its own gateway API key — never Cephable's key. */
export interface Caller {
    id: string;
    label: string;
    /** Allow `mcpServers` with `transport: "http" | "sse"`. Still never `stdio`. */
    allowInlineMcp: boolean;
    /** Ceiling on `timeoutMs`, so one caller cannot hold the single inference slot all day. */
    maxTimeoutMs: number;
}

export interface PolicyRejection {
    field: string;
    reason: string;
}

export interface PolicyResult {
    /** The request to forward, rewritten. Only present when `rejections` is empty. */
    request?: Record<string, unknown>;
    rejections: PolicyRejection[];
    /** What the policy changed, for the audit log and the response headers. */
    applied: string[];
}

/**
 * Hard ceiling regardless of caller config. A parked or long-running request holds the host's only
 * inference slot; nobody remote gets to hold it for a quarter of an hour.
 */
export const ABSOLUTE_MAX_TIMEOUT_MS = 300_000;

/** Prompt length cap. The upstream cap is 1 MiB of JSON; this is about cost, not correctness. */
export const MAX_PROMPT_CHARS = 8_000;

const MAX_CLIENT_TOOLS = 32;
const MAX_INLINE_MCP = 4;

/**
 * Fields a remote caller may set at all. Anything else is dropped rather than forwarded, so a new
 * upstream option cannot become a new remote capability just because Cephable shipped it.
 *
 * Deliberately absent, and why:
 *
 * - `allowDestructiveTools` — approves `delete_path`, `run_command` and `move_path` on the host.
 * - `restrictToWorkspace` — we set this ourselves, to `true`. A caller cannot widen it.
 * - `selectedSkillIds` / `selectedMcpServerIds` — the host user's own configured skills and servers,
 *   which may hold their credentials. Not a remote caller's to select.
 * - `hitlAnswers` — answers to questions the agent asks the *user*. There is no user here.
 * - `continuation` — would let one caller resume the conversation another caller (or the person at the
 *   machine) was having.
 */
const ALLOWED_FIELDS = new Set([
    'prompt',
    'taskId',
    'timeoutMs',
    'thinkingLevel',
    'additionalWorkflowPrompt',
    'answerContract',
    'include',
    'clientTools',
    'mcpServers',
]);

const THINKING_LEVELS = new Set(['low', 'medium', 'high', 'max']);

/**
 * Validate and rewrite one `/v1/runs` request for a remote caller.
 *
 * Allowlist, not denylist: we build a fresh object from fields we recognise. A denylist would silently
 * start forwarding whatever the next Cephable release adds.
 */
export function applyRunPolicy(body: unknown, caller: Caller): PolicyResult {
    const rejections: PolicyRejection[] = [];
    const applied: string[] = [];

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { rejections: [{ field: 'body', reason: 'Expected a JSON object' }], applied };
    }
    const input = body as Record<string, unknown>;

    // Say what we dropped rather than pretending we honoured it — a caller debugging why its
    // `allowDestructiveTools: true` did nothing deserves to be told.
    for (const key of Object.keys(input)) {
        if (!ALLOWED_FIELDS.has(key)) {
            applied.push(`dropped ${key}`);
        }
    }

    // --- prompt -------------------------------------------------------------
    const prompt = input.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
        rejections.push({ field: 'prompt', reason: 'prompt must be a non-empty string' });
    } else if (prompt.length > MAX_PROMPT_CHARS) {
        rejections.push({
            field: 'prompt',
            reason: `prompt must be ${MAX_PROMPT_CHARS} characters or fewer (got ${prompt.length})`,
        });
    }

    // --- the two fields a caller must not be able to set --------------------
    if (input.allowDestructiveTools === true) {
        rejections.push({
            field: 'allowDestructiveTools',
            reason:
                'Refused. This would approve delete_path, run_command and move_path on the host machine. ' +
                'A remote caller cannot enable it.',
        });
    }
    if (input.restrictToWorkspace === false) {
        rejections.push({
            field: 'restrictToWorkspace',
            reason:
                'Refused. Runs through this gateway are always confined to the host workspace folder. ' +
                'A remote caller cannot widen the filesystem scope.',
        });
    }
    if (input.continuation === true) {
        rejections.push({
            field: 'continuation',
            reason:
                'Refused. Conversation state is shared with the host user and other callers, so a ' +
                'continuation could resume a conversation that is not yours. Send self-contained prompts.',
        });
    }

    // --- timeout ------------------------------------------------------------
    const ceiling = Math.min(caller.maxTimeoutMs, ABSOLUTE_MAX_TIMEOUT_MS);
    let timeoutMs = ceiling;
    if (input.timeoutMs !== undefined) {
        if (typeof input.timeoutMs !== 'number' || !Number.isFinite(input.timeoutMs)) {
            rejections.push({ field: 'timeoutMs', reason: 'timeoutMs must be a number' });
        } else if (input.timeoutMs < 1000) {
            rejections.push({ field: 'timeoutMs', reason: 'timeoutMs must be at least 1000' });
        } else {
            timeoutMs = Math.min(input.timeoutMs, ceiling);
            if (timeoutMs !== input.timeoutMs) applied.push(`timeoutMs capped to ${timeoutMs}`);
        }
    }

    // --- caller-executed tools ----------------------------------------------
    // Safe to allow: they run in the *caller's* process, not on the host.
    let clientTools: unknown[] | undefined;
    if (input.clientTools !== undefined) {
        if (!Array.isArray(input.clientTools)) {
            rejections.push({ field: 'clientTools', reason: 'clientTools must be an array' });
        } else if (input.clientTools.length > MAX_CLIENT_TOOLS) {
            rejections.push({
                field: 'clientTools',
                reason: `clientTools must contain ${MAX_CLIENT_TOOLS} tools or fewer`,
            });
        } else {
            clientTools = input.clientTools;
        }
    }

    // --- inline MCP servers -------------------------------------------------
    let mcpServers: unknown[] | undefined;
    if (input.mcpServers !== undefined) {
        if (!caller.allowInlineMcp) {
            rejections.push({
                field: 'mcpServers',
                reason: 'Refused. This API key is not permitted to declare inline MCP servers.',
            });
        } else if (!Array.isArray(input.mcpServers)) {
            rejections.push({ field: 'mcpServers', reason: 'mcpServers must be an array' });
        } else if (input.mcpServers.length > MAX_INLINE_MCP) {
            rejections.push({
                field: 'mcpServers',
                reason: `mcpServers must contain ${MAX_INLINE_MCP} servers or fewer`,
            });
        } else {
            const stdio = input.mcpServers.filter(
                (server) => (server as { transport?: unknown })?.transport === 'stdio'
            );
            if (stdio.length > 0) {
                rejections.push({
                    field: 'mcpServers',
                    reason:
                        'Refused. transport "stdio" spawns a process on the host with your command and ' +
                        'arguments — arbitrary local code execution, and not gated by allowDestructiveTools. ' +
                        'Use "http" or "sse" and host the server yourself.',
                });
            } else {
                mcpServers = input.mcpServers;
            }
        }
    }

    // --- pass-through, validated --------------------------------------------
    if (input.thinkingLevel !== undefined && !THINKING_LEVELS.has(input.thinkingLevel as string)) {
        rejections.push({
            field: 'thinkingLevel',
            reason: 'thinkingLevel must be one of low, medium, high, max',
        });
    }
    for (const field of ['taskId', 'additionalWorkflowPrompt', 'answerContract'] as const) {
        if (input[field] !== undefined && typeof input[field] !== 'string') {
            rejections.push({ field, reason: `${field} must be a string` });
        }
    }

    if (rejections.length > 0) return { rejections, applied };

    const request: Record<string, unknown> = {
        prompt: (prompt as string).trim(),
        timeoutMs,

        // Set by us, not the caller. `restrictToWorkspace` can only narrow — if the host user has
        // configured their own workspace restriction, theirs wins and this is ignored. Either way a
        // remote caller never gets the run of the host's disk.
        restrictToWorkspace: true,
        allowDestructiveTools: false,
        continuation: false,

        // `events` is huge and of no use to a remote caller; `trace` is the raw model conversation,
        // which can echo host context we would rather not ship off the machine.
        include: { steps: true, trace: false, events: false },
    };
    applied.push('restrictToWorkspace forced on', 'allowDestructiveTools forced off', 'trace and events stripped');

    if (typeof input.taskId === 'string') request.taskId = input.taskId;
    if (typeof input.thinkingLevel === 'string') request.thinkingLevel = input.thinkingLevel;
    if (typeof input.additionalWorkflowPrompt === 'string') {
        request.additionalWorkflowPrompt = input.additionalWorkflowPrompt;
    }
    if (typeof input.answerContract === 'string') request.answerContract = input.answerContract;
    if (clientTools) request.clientTools = clientTools;
    if (mcpServers) request.mcpServers = mcpServers;

    return { request, rejections, applied };
}

/**
 * Trim a run record before it goes back over the wire.
 *
 * The upstream record is written for a client on the same machine and casually includes host detail:
 * absolute filesystem paths, the workspace location, the machine's CPU and memory, tool arguments that
 * may name local files. A remote caller needs the answer and a shape of what happened, not a map of
 * someone's computer.
 */
export function sanitizeRunRecord(record: Record<string, unknown>): Record<string, unknown> {
    const steps = Array.isArray(record.steps) ? record.steps : [];

    return {
        schemaVersion: record.schemaVersion,
        requestId: record.requestId,
        taskId: record.taskId,
        status: record.status,
        answer: record.answer,
        finalAnswer: record.finalAnswer,
        errorCode: record.errorCode,
        durationMs: record.durationMs,
        usage: record.usage,

        // Kept: the caller needs these to drive the park/resume loop.
        toolCalls: record.toolCalls,
        resumeToken: record.resumeToken,

        // A shape of the work, with the host's filesystem removed. Notably absent: toolArgs,
        // producedFilePath, producedContent, resultSummary — all of which leak local paths or content.
        steps: steps.map((step) => {
            const entry = step as Record<string, unknown>;
            return {
                index: entry.index,
                title: entry.title,
                status: entry.status,
                toolName: entry.toolName,
            };
        }),

        // Deliberately not forwarded: model, appVersion, backend, contextSize, trace, events, and the
        // host's cpu / totalMemoryBytes / workspace. Useful locally, nobody's business remotely.
    };
}

/** Validate a `/tool-results` resume body. The ids are the upstream's, so we only check the shape. */
export function validateToolResults(body: unknown): { results?: unknown[]; rejections: PolicyRejection[] } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { rejections: [{ field: 'body', reason: 'Expected a JSON object' }] };
    }
    const results = (body as { results?: unknown }).results;
    if (!Array.isArray(results)) {
        return { rejections: [{ field: 'results', reason: 'results must be an array' }] };
    }
    if (results.length > MAX_CLIENT_TOOLS) {
        return { rejections: [{ field: 'results', reason: 'too many results' }] };
    }
    for (const [index, result] of results.entries()) {
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
            return { rejections: [{ field: `results[${index}]`, reason: 'must be an object' }] };
        }
        if (typeof (result as { id?: unknown }).id !== 'string') {
            return { rejections: [{ field: `results[${index}].id`, reason: 'id is required' }] };
        }
    }
    return { results, rejections: [] };
}
