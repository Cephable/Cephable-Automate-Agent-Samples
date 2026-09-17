/**
 * The gateway's HTTP surface.
 *
 * Built as a factory returning a Fastify instance so the tests can drive it with `inject()` against a
 * stub upstream, with no ports and no real Cephable.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { authenticate, bearerFrom, type GatewayConfig } from './auth.ts';
import { applyRunPolicy, sanitizeRunRecord, validateToolResults, type Caller } from './policy.ts';
import { CephableUpstream, UpstreamError } from './upstream.ts';

export interface AppOptions {
    config: GatewayConfig;
    upstream: Pick<CephableUpstream, 'health' | 'isReady' | 'startRun' | 'resumeRun' | 'cancelRun' | 'stats'>;
    /** Requests per minute, per API key. */
    rateLimitPerMinute?: number;
    logger?: boolean;
}

declare module 'fastify' {
    interface FastifyRequest {
        caller?: Caller;
    }
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
    const app = Fastify({
        logger: options.logger ?? false,
        // A remote caller has no business setting these; trusting them would let a caller forge the
        // client IP the rate limiter keys on.
        trustProxy: false,
        bodyLimit: 1024 * 1024, // matches the upstream cap
    });

    await app.register(rateLimit, {
        max: options.rateLimitPerMinute ?? 20,
        timeWindow: '1 minute',
        // Per API key, not per IP: several callers behind one NAT should not share a budget, and one
        // caller rotating IPs should not get a fresh one.
        keyGenerator: (request) => request.caller?.id ?? request.ip,
    });

    // ── auth ────────────────────────────────────────────────────────────────
    app.addHook('onRequest', async (request, reply) => {
        if (request.url === '/healthz') return; // liveness probe, deliberately unauthenticated

        const caller = authenticate(options.config, bearerFrom(request.headers.authorization));
        if (!caller) {
            // No detail about why. A caller debugging its own integration knows which key it sent.
            return reply.code(401).send({
                error: { message: 'Unauthorized', type: 'authentication_error' },
            });
        }
        request.caller = caller;
    });

    function audit(request: FastifyRequest, event: string, detail: Record<string, unknown> = {}): void {
        // The access key is never logged, and neither is the prompt — prompts are user content, and a
        // gateway log is the last place it should accumulate. Lengths and ids only.
        request.log.info({ event, caller: request.caller?.id, ...detail }, event);
    }

    // ── liveness ────────────────────────────────────────────────────────────
    // Says nothing about the host. `/v1/status` (authenticated) is where real detail lives.
    app.get('/healthz', async () => ({ status: 'ok' }));

    // ── status ──────────────────────────────────────────────────────────────
    app.get('/v1/status', async (request, reply) => {
        try {
            const health = await options.upstream.health();
            const stats = options.upstream.stats;
            // A deliberately thin projection. The upstream /health reports the machine's CPU model,
            // total memory, absolute workspace path and app version — host detail a remote caller does
            // not need in order to decide whether to send a request.
            return {
                status: 'ok',
                assistant: {
                    ready: health.busy !== true && (health.workflowStatus === 'idle' || health.workflowStatus === 'terminated'),
                    busy: health.busy === true,
                    awaitingToolResults: health.awaitingToolResults === true,
                },
                queue: { depth: stats.queueDepth, yoursIsActive: stats.activeCallerId === request.caller!.id },
            };
        } catch (error) {
            const status = error instanceof UpstreamError ? error.status : 502;
            return reply.code(status).send({
                error: { message: 'The local assistant is unavailable.', type: 'upstream_unavailable' },
            });
        }
    });

    // ── runs ────────────────────────────────────────────────────────────────
    app.post('/v1/runs', async (request, reply) => {
        const caller = request.caller!;
        const policy = applyRunPolicy(request.body, caller);

        if (policy.rejections.length > 0) {
            audit(request, 'run.rejected', { rejections: policy.rejections.map((r) => r.field) });
            return reply.code(400).send({
                error: {
                    message: 'The request was refused by gateway policy.',
                    type: 'policy_violation',
                    rejections: policy.rejections,
                },
            });
        }

        audit(request, 'run.started', {
            promptChars: (policy.request!.prompt as string).length,
            timeoutMs: policy.request!.timeoutMs,
            clientTools: Array.isArray(policy.request!.clientTools) ? policy.request!.clientTools.length : 0,
            mcpServers: Array.isArray(policy.request!.mcpServers) ? policy.request!.mcpServers.length : 0,
        });

        try {
            const record = await options.upstream.startRun(caller.id, policy.request!);
            audit(request, 'run.finished', { status: record.status, durationMs: record.durationMs });
            // Tell the caller what we changed, so a silently-capped timeout is discoverable.
            reply.header('x-gateway-policy', policy.applied.join('; '));
            return reply.code(httpStatusFor(record)).send(sanitizeRunRecord(record));
        } catch (error) {
            return sendUpstreamError(reply, request, error);
        }
    });

    // ── resume a parked run ─────────────────────────────────────────────────
    app.post<{ Params: { token: string } }>('/v1/runs/:token/tool-results', async (request, reply) => {
        const caller = request.caller!;
        const { results, rejections } = validateToolResults(request.body);
        if (rejections.length > 0) {
            return reply.code(400).send({
                error: { message: 'Invalid tool results.', type: 'invalid_request_error', rejections },
            });
        }

        try {
            const record = await options.upstream.resumeRun(caller.id, request.params.token, results!);
            audit(request, 'run.resumed', { status: record.status, results: results!.length });
            return reply.code(httpStatusFor(record)).send(sanitizeRunRecord(record));
        } catch (error) {
            return sendUpstreamError(reply, request, error);
        }
    });

    // ── cancel ──────────────────────────────────────────────────────────────
    app.post('/v1/runs/cancel', async (request, reply) => {
        const force = (request.body as { force?: unknown } | undefined)?.force === true;
        try {
            const result = await options.upstream.cancelRun(request.caller!.id, force);
            audit(request, 'run.cancelled', { force, stopped: result.stopped });
            return { stopped: result.stopped === true, mode: result.mode };
        } catch (error) {
            return sendUpstreamError(reply, request, error);
        }
    });

    // Everything else, including the upstream routes we deliberately do not expose:
    // /v1/automate/models/select (would change the host user's session model) and
    // /v1/chat/completions (an OpenAI-shaped surface we have not policy-checked).
    app.setNotFoundHandler(async (_request, reply) =>
        reply.code(404).send({ error: { message: 'Not found', type: 'not_found' } })
    );

    return app;
}

/** A parked run is a successful exchange; only a genuinely failed run is a 500-shaped outcome. */
function httpStatusFor(record: Record<string, unknown>): number {
    if (record.status === 'completed' || record.status === 'awaiting_tool_results') return 200;
    return 500;
}

function sendUpstreamError(reply: any, request: FastifyRequest, error: unknown) {
    if (error instanceof UpstreamError) {
        request.log.warn({ event: 'upstream.error', status: error.status, message: error.message });
        // 4xx from upstream is usually the caller's fault and safe to relay; 5xx is the host's problem
        // and gets a generic message, because upstream errors can name local paths.
        const message =
            error.status >= 400 && error.status < 500
                ? error.message
                : 'The local assistant could not complete the request.';
        return reply.code(error.status).send({ error: { message, type: 'upstream_error' } });
    }

    request.log.error({ event: 'gateway.error', err: error });
    return reply.code(500).send({ error: { message: 'Internal error', type: 'internal_error' } });
}
