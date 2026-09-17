/**
 * The upstream half: talking to the local Cephable server, and serialising access to it.
 *
 * Cephable has exactly one inference slot, shared with the person sitting at the machine. A public
 * address in front of it means several callers can arrive at once, so the gateway has to decide what
 * happens to the second one. Returning 409 and telling them to try later is honest but unusable; so we
 * queue, with a bounded depth and a wait ceiling, and we refuse cleanly when the queue is full.
 */

const DEFAULT_PORT = 4317;
const PORT_ATTEMPTS = 12;

export interface UpstreamOptions {
    endpoint?: string;
    token: string;
    /** How many callers may wait for the slot before we start refusing. */
    maxQueueDepth?: number;
    /** How long a caller may sit in the queue before we give up on their behalf. */
    maxQueueWaitMs?: number;
}

export class UpstreamError extends Error {
    // Written out longhand rather than as constructor parameter properties: Node runs these files
    // directly with --experimental-strip-types, which only erases types and cannot desugar them.
    readonly status: number;
    readonly body?: unknown;

    constructor(message: string, status: number, body?: unknown) {
        super(message);
        this.name = 'UpstreamError';
        this.status = status;
        this.body = body;
    }
}

/** The run currently occupying the slot, and which caller owns it. */
interface ActiveRun {
    callerId: string;
    resumeToken?: string;
}

export class CephableUpstream {
    private endpoint: string | null;
    private readonly token: string;
    private readonly maxQueueDepth: number;
    private readonly maxQueueWaitMs: number;

    /** Tail of the promise chain that serialises slot access. */
    private tail: Promise<unknown> = Promise.resolve();
    private queueDepth = 0;
    private active: ActiveRun | null = null;

    constructor(options: UpstreamOptions) {
        this.endpoint = options.endpoint ?? null;
        this.token = options.token;
        this.maxQueueDepth = options.maxQueueDepth ?? 4;
        this.maxQueueWaitMs = options.maxQueueWaitMs ?? 60_000;
    }

    /**
     * Find the local Cephable server.
     *
     * Same sweep every client needs: Cephable binds the next free port when its preferred one is taken,
     * and confirming `service` matters because an OpenTelemetry collector also defaults to 4317.
     */
    async resolveEndpoint(): Promise<string> {
        if (this.endpoint) return this.endpoint;

        for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
            const candidate = `http://127.0.0.1:${DEFAULT_PORT + offset}`;
            try {
                const response = await fetch(`${candidate}/health`, {
                    headers: { authorization: `Bearer ${this.token}` },
                    signal: AbortSignal.timeout(3000),
                });
                if (response.status === 401) {
                    throw new UpstreamError(
                        `Cephable is listening on ${candidate} but rejected the access key. ` +
                            'It may have been regenerated.',
                        500
                    );
                }
                if (!response.ok) continue;
                const body = (await response.json()) as { service?: string };
                if (body.service === 'cephable-agent') {
                    this.endpoint = candidate;
                    return candidate;
                }
            } catch (error) {
                if (error instanceof UpstreamError) throw error;
                // Nothing listening here; keep sweeping.
            }
        }

        throw new UpstreamError(
            `No Cephable server answered on 127.0.0.1:${DEFAULT_PORT}-${DEFAULT_PORT + PORT_ATTEMPTS - 1}. ` +
                'Is the desktop app running with the Automate HTTP Server enabled?',
            503
        );
    }

    private async request<T>(route: string, init: RequestInit, timeoutMs: number): Promise<T> {
        const endpoint = await this.resolveEndpoint();
        const response = await fetch(`${endpoint}${route}`, {
            ...init,
            headers: {
                // The Cephable key is attached here and only here. It is never read from, nor echoed
                // to, a remote request.
                authorization: `Bearer ${this.token}`,
                'content-type': 'application/json',
                ...(init.headers ?? {}),
            },
            signal: AbortSignal.timeout(timeoutMs),
        });

        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

        // A failed run is HTTP 500 carrying a complete record. Only a body without schemaVersion means
        // the request never started one — so this check is what separates "the agent could not do it"
        // from "the gateway is misconfigured".
        if (!response.ok && body.schemaVersion !== 1) {
            const error = body.error as { message?: string } | undefined;
            throw new UpstreamError(
                error?.message ?? `${route} returned HTTP ${response.status}`,
                response.status,
                body
            );
        }
        return body as T;
    }

    async health(): Promise<Record<string, unknown>> {
        return this.request('/health', { method: 'GET' }, 10_000);
    }

    /** True when the local assistant is free — including free of a parked run. */
    async isReady(): Promise<boolean> {
        const health = await this.health();
        const status = health.workflowStatus;
        return health.busy !== true && (status === 'idle' || status === 'terminated');
    }

    /**
     * Take the slot, run `work`, release it.
     *
     * Serialised through a promise chain rather than a real job store, because there is exactly one
     * slot and the queue only has to survive this process. A production deployment in front of several
     * machines would put a broker here and route by host.
     */
    private async withSlot<T>(callerId: string, work: () => Promise<T>): Promise<T> {
        if (this.queueDepth >= this.maxQueueDepth) {
            throw new UpstreamError(
                `The assistant is busy and ${this.queueDepth} callers are already waiting. Try again shortly.`,
                503
            );
        }

        this.queueDepth += 1;
        const waitStarted = Date.now();

        const run = this.tail.then(
            async () => {
                if (Date.now() - waitStarted > this.maxQueueWaitMs) {
                    throw new UpstreamError('Timed out waiting for the assistant to become free.', 504);
                }
                this.active = { callerId };
                try {
                    return await work();
                } finally {
                    this.active = null;
                }
            },
            async () => {
                // A previous caller failing must not poison the queue for the next one.
                this.active = { callerId };
                try {
                    return await work();
                } finally {
                    this.active = null;
                }
            }
        );

        // Keep the chain alive regardless of this caller's outcome.
        this.tail = run.then(
            () => undefined,
            () => undefined
        );

        try {
            return await run;
        } finally {
            this.queueDepth -= 1;
        }
    }

    /** Start a run. The returned record may be `awaiting_tool_results`. */
    async startRun(callerId: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
        const timeoutMs = (request.timeoutMs as number) ?? 120_000;
        return this.withSlot(callerId, async () => {
            const record = await this.request<Record<string, unknown>>(
                '/v1/runs',
                { method: 'POST', body: JSON.stringify(request) },
                timeoutMs + 15_000
            );
            // Remember who owns a parked run, so only they can resume or cancel it.
            if (record.status === 'awaiting_tool_results' && typeof record.resumeToken === 'string') {
                this.parked.set(record.resumeToken, callerId);
            }
            return record;
        });
    }

    /**
     * Resume a parked run.
     *
     * Not queued: the run being resumed is *why* the slot is occupied, so waiting for the slot would
     * deadlock it. The ownership check is what stops one caller steering another's run.
     */
    async resumeRun(
        callerId: string,
        resumeToken: string,
        results: unknown[]
    ): Promise<Record<string, unknown>> {
        const owner = this.parked.get(resumeToken);
        if (owner !== callerId) {
            throw new UpstreamError('No parked run matches that resume token for this API key.', 404);
        }

        const record = await this.request<Record<string, unknown>>(
            `/v1/runs/${encodeURIComponent(resumeToken)}/tool-results`,
            { method: 'POST', body: JSON.stringify({ results }) },
            135_000
        );

        this.parked.delete(resumeToken);
        if (record.status === 'awaiting_tool_results' && typeof record.resumeToken === 'string') {
            this.parked.set(record.resumeToken, callerId);
        }
        return record;
    }

    /**
     * Cancel — but only a run this caller owns.
     *
     * Upstream `/v1/automate/cancel` stops whatever is running, whoever started it, including a run the
     * person at the machine started from the app's own panel. Exposing that unguarded would let any
     * remote caller interrupt the host user's work.
     */
    async cancelRun(callerId: string, force: boolean): Promise<Record<string, unknown>> {
        const owned =
            this.active?.callerId === callerId ||
            [...this.parked.values()].includes(callerId);
        if (!owned) {
            throw new UpstreamError('You have no run in flight to cancel.', 404);
        }

        for (const [token, owner] of this.parked) {
            if (owner === callerId) this.parked.delete(token);
        }
        return this.request('/v1/automate/cancel', { method: 'POST', body: JSON.stringify({ force }) }, 30_000);
    }

    /** Resume tokens of parked runs, mapped to the caller that owns each. */
    private readonly parked = new Map<string, string>();

    get stats(): { queueDepth: number; activeCallerId: string | null; parkedRuns: number } {
        return {
            queueDepth: this.queueDepth,
            activeCallerId: this.active?.callerId ?? null,
            parkedRuns: this.parked.size,
        };
    }
}
