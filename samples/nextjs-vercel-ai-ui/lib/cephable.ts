/**
 * Server-side Cephable client. Runs only in the Next.js server, never in the browser.
 *
 * That is not a style choice: the Automate server sends no CORS headers and has no `OPTIONS` handler,
 * so a `fetch` from a page on an `http(s)://` origin fails preflight. The access key should not be in
 * a browser bundle either. So the route handler is the client, and the browser talks to the route.
 */

const DEFAULT_PORT = 4317;
const PORT_ATTEMPTS = 12;

export interface CephableHealth {
    status: string;
    service: string;
    appVersion: string;
    platform: string;
    workflowStatus: string;
    busy: boolean;
    awaitingToolResults?: boolean;
    modelName: string | null;
    contextSize: number | null;
    backend: { flavorId?: string; accelerator: string; cpuFallback: boolean } | null;
}

export interface CephableToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface CephableStep {
    index: number;
    title: string;
    status: string;
    toolName?: string;
    resultSummary?: string;
}

export interface CephableRunRecord {
    schemaVersion: 1;
    requestId: string;
    status: 'completed' | 'failed' | 'canceled' | 'terminated' | 'awaiting_tool_results';
    answer: string;
    finalAnswer?: string;
    errorCode?: string;
    durationMs: number;
    model: string;
    appVersion: string;
    backend: CephableHealth['backend'];
    steps?: CephableStep[];
    usage: { inputTokens: number; outputTokens: number; tps: number } | null;
    toolCalls?: CephableToolCall[];
    resumeToken?: string;
}

export class CephableError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'CephableError';
        this.status = status;
    }

    get isBusy(): boolean {
        return this.status === 409;
    }
}

export interface ClientToolDefinition {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
}

let cachedEndpoint: string | null = null;

function token(): string {
    const value = process.env.CEPHABLE_AUTOMATE_KEY;
    if (!value) {
        throw new CephableError(
            'CEPHABLE_AUTOMATE_KEY is not set. Copy the key from Cephable: Extensions > Cephable ' +
                'features > Build & Extend > Automate HTTP Server, and put it in .env.local.',
            500
        );
    }
    return value;
}

/**
 * Find the local Cephable server, once per server process.
 *
 * Cephable binds the next free port when its preferred one is taken, so a hardcoded endpoint silently
 * breaks. Confirming `service` matters because an OpenTelemetry collector also defaults to 4317.
 */
export async function resolveEndpoint(): Promise<string> {
    if (cachedEndpoint) return cachedEndpoint;
    if (process.env.CEPHABLE_ENDPOINT) {
        cachedEndpoint = process.env.CEPHABLE_ENDPOINT;
        return cachedEndpoint;
    }

    for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
        const candidate = `http://127.0.0.1:${DEFAULT_PORT + offset}`;
        try {
            const response = await fetch(`${candidate}/health`, {
                headers: { authorization: `Bearer ${token()}` },
                signal: AbortSignal.timeout(3000),
                cache: 'no-store',
            });
            if (response.status === 401) {
                throw new CephableError(
                    `Cephable is listening on ${candidate} but rejected the access key. It may have been regenerated.`,
                    401
                );
            }
            if (!response.ok) continue;
            const body = (await response.json()) as { service?: string };
            if (body.service === 'cephable-agent') {
                cachedEndpoint = candidate;
                return candidate;
            }
        } catch (error) {
            if (error instanceof CephableError) throw error;
            // Nothing listening here; keep sweeping.
        }
    }

    throw new CephableError(
        `No Cephable server answered on 127.0.0.1:${DEFAULT_PORT}-${DEFAULT_PORT + PORT_ATTEMPTS - 1}. ` +
            'Open Cephable and enable Extensions > Cephable features > Build & Extend > Automate HTTP Server.',
        503
    );
}

async function request<T>(route: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const endpoint = await resolveEndpoint();
    const response = await fetch(`${endpoint}${route}`, {
        ...init,
        headers: {
            authorization: `Bearer ${token()}`,
            'content-type': 'application/json',
            ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
    });

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    // A failed run is HTTP 500 with a COMPLETE record. Only a body without schemaVersion means the
    // request never started one.
    if (!response.ok && body.schemaVersion !== 1) {
        const error = body.error as { message?: string } | undefined;
        throw new CephableError(error?.message ?? `${route} returned HTTP ${response.status}`, response.status);
    }
    return body as T;
}

export function health(): Promise<CephableHealth> {
    return request<CephableHealth>('/health', { method: 'GET' }, 10_000);
}

export async function waitUntilReady(timeoutMs = 60_000): Promise<CephableHealth> {
    const deadline = Date.now() + timeoutMs;
    let last: CephableHealth | undefined;
    while (Date.now() < deadline) {
        last = await health();
        if (!last.busy && (last.workflowStatus === 'idle' || last.workflowStatus === 'terminated')) return last;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new CephableError(
        `Cephable stayed busy (last status: ${last?.workflowStatus}). ` +
            'One inference slot, shared with the app\'s own panel.',
        409
    );
}

export interface StartRunOptions {
    prompt: string;
    clientTools?: ClientToolDefinition[];
    timeoutMs?: number;
    thinkingLevel?: 'low' | 'medium' | 'high' | 'max';
    additionalWorkflowPrompt?: string;
    restrictToWorkspace?: boolean;
}

export function startRun(options: StartRunOptions): Promise<CephableRunRecord> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    return request<CephableRunRecord>(
        '/v1/runs',
        {
            method: 'POST',
            body: JSON.stringify({
                prompt: options.prompt,
                timeoutMs,
                thinkingLevel: options.thinkingLevel,
                additionalWorkflowPrompt: options.additionalWorkflowPrompt,
                clientTools: options.clientTools,
                // This sample's tools are all in-process reads of its own demo data, so the agent has
                // no reason to touch the filesystem. Narrow by default.
                restrictToWorkspace: options.restrictToWorkspace ?? true,
                allowDestructiveTools: false,
                include: { steps: true, trace: false, events: false },
            }),
        },
        // Above the server's own deadline, so its timeout wins rather than us abandoning a live run.
        timeoutMs + 15_000
    );
}

export function resumeRun(
    resumeToken: string,
    results: Array<{ id: string; result?: unknown; error?: string }>
): Promise<CephableRunRecord> {
    return request<CephableRunRecord>(
        `/v1/runs/${encodeURIComponent(resumeToken)}/tool-results`,
        { method: 'POST', body: JSON.stringify({ results }) },
        // The server gives a parked run two minutes per round before it self-cancels.
        135_000
    );
}

export function cancelRun(force = false): Promise<unknown> {
    return request('/v1/automate/cancel', { method: 'POST', body: JSON.stringify({ force }) }, 30_000);
}
