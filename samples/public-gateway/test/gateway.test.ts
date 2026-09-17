/**
 * The policy tests are the point of this file.
 *
 * Everything else in the gateway is plumbing you could write a dozen ways. The policy is the thing
 * standing between a public address and someone's laptop, so each refusal it makes gets a test that
 * fails loudly if a future edit softens it.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.ts';
import { generateKey, hashKey, authenticate, bearerFrom, type GatewayConfig } from '../src/auth.ts';
import { applyRunPolicy, sanitizeRunRecord, ABSOLUTE_MAX_TIMEOUT_MS, type Caller } from '../src/policy.ts';

// ── fixtures ───────────────────────────────────────────────────────────────

const CALLER: Caller = { id: 'test', label: 'Test', allowInlineMcp: true, maxTimeoutMs: 120_000 };
const NO_MCP_CALLER: Caller = { ...CALLER, id: 'no-mcp', allowInlineMcp: false };

const KEY = generateKey();
const OTHER_KEY = generateKey();
const CONFIG: GatewayConfig = {
    keys: [
        { id: 'test', label: 'Test', sha256: hashKey(KEY), allowInlineMcp: true, maxTimeoutMs: 120_000 },
        { id: 'other', label: 'Other', sha256: hashKey(OTHER_KEY), allowInlineMcp: false, maxTimeoutMs: 60_000 },
    ],
};

function completedRecord(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schemaVersion: 1,
        requestId: 'automate-run-1',
        status: 'completed',
        answer: 'done',
        durationMs: 1000,
        model: 'gemma-4-4b-it-Q4_K_M.gguf',
        appVersion: '4.2.1',
        backend: { accelerator: 'vulkan', cpuFallback: false },
        steps: [],
        usage: null,
        ...extra,
    };
}

/** A stub upstream that records what the gateway forwarded. */
function stubUpstream(overrides: Partial<Record<string, unknown>> = {}) {
    const calls: { method: string; args: unknown[] }[] = [];
    const parked = new Map<string, string>();

    return {
        calls,
        parked,
        health: async () => ({ busy: false, workflowStatus: 'idle', awaitingToolResults: false, appVersion: '4.2.1', modelName: 'x.gguf', cpu: 'SECRET CPU', workspace: 'C:\\Users\\host\\secret' }),
        isReady: async () => true,
        startRun: async (callerId: string, request: Record<string, unknown>) => {
            calls.push({ method: 'startRun', args: [callerId, request] });
            const record = (overrides.startRun as Record<string, unknown>) ?? completedRecord();
            if (record.status === 'awaiting_tool_results') parked.set(record.resumeToken as string, callerId);
            return record;
        },
        resumeRun: async (callerId: string, token: string, results: unknown[]) => {
            calls.push({ method: 'resumeRun', args: [callerId, token, results] });
            if (parked.get(token) !== callerId) {
                const { UpstreamError } = await import('../src/upstream.ts');
                throw new UpstreamError('No parked run matches that resume token for this API key.', 404);
            }
            return completedRecord();
        },
        cancelRun: async (callerId: string, force: boolean) => {
            calls.push({ method: 'cancelRun', args: [callerId, force] });
            return { stopped: true, mode: force ? 'terminate' : 'cancel' };
        },
        stats: { queueDepth: 0, activeCallerId: null, parkedRuns: 0 },
    };
}

async function app(upstream = stubUpstream()) {
    return { instance: await buildApp({ config: CONFIG, upstream, rateLimitPerMinute: 1000 }), upstream };
}

function auth(key = KEY) {
    return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

// ── the refusals that matter ───────────────────────────────────────────────

test('refuses allowDestructiveTools, because it would approve run_command on the host', () => {
    const result = applyRunPolicy({ prompt: 'hi', allowDestructiveTools: true }, CALLER);
    assert.equal(result.request, undefined);
    const rejection = result.rejections.find((r) => r.field === 'allowDestructiveTools');
    assert.ok(rejection, 'expected an allowDestructiveTools rejection');
    assert.match(rejection.reason, /run_command/);
});

test('refuses an attempt to widen the filesystem scope', () => {
    const result = applyRunPolicy({ prompt: 'hi', restrictToWorkspace: false }, CALLER);
    assert.ok(result.rejections.some((r) => r.field === 'restrictToWorkspace'));
});

test('forces restrictToWorkspace on and allowDestructiveTools off even when unmentioned', () => {
    const result = applyRunPolicy({ prompt: 'hi' }, CALLER);
    assert.equal(result.request!.restrictToWorkspace, true);
    assert.equal(result.request!.allowDestructiveTools, false);
});

test('refuses a stdio inline MCP server, which is local code execution on the host', () => {
    const result = applyRunPolicy(
        {
            prompt: 'hi',
            mcpServers: [
                { name: 'evil', description: 'x', transport: 'stdio', command: 'powershell', args: ['-c', 'whoami'] },
            ],
        },
        CALLER
    );
    assert.equal(result.request, undefined);
    const rejection = result.rejections.find((r) => r.field === 'mcpServers');
    assert.ok(rejection);
    assert.match(rejection.reason, /arbitrary local code execution/);
});

test('refuses a stdio server even when hidden among http ones', () => {
    const result = applyRunPolicy(
        {
            prompt: 'hi',
            mcpServers: [
                { name: 'ok', description: 'x', transport: 'http', url: 'https://example.test/mcp' },
                { name: 'sneaky', description: 'x', transport: 'stdio', command: 'sh' },
            ],
        },
        CALLER
    );
    assert.ok(result.rejections.some((r) => r.field === 'mcpServers'));
});

test('allows an http inline MCP server for a caller permitted to use them', () => {
    const result = applyRunPolicy(
        { prompt: 'hi', mcpServers: [{ name: 'mine', description: 'x', transport: 'http', url: 'https://example.test/mcp' }] },
        CALLER
    );
    assert.equal(result.rejections.length, 0);
    assert.equal((result.request!.mcpServers as unknown[]).length, 1);
});

test('refuses inline MCP servers for a caller not permitted to use them', () => {
    const result = applyRunPolicy(
        { prompt: 'hi', mcpServers: [{ name: 'mine', description: 'x', transport: 'http', url: 'https://example.test/mcp' }] },
        NO_MCP_CALLER
    );
    assert.ok(result.rejections.some((r) => r.field === 'mcpServers'));
});

test("refuses continuation, which could resume someone else's conversation", () => {
    const result = applyRunPolicy({ prompt: 'hi', continuation: true }, CALLER);
    assert.ok(result.rejections.some((r) => r.field === 'continuation'));
});

test("drops the host user's own skills and configured MCP servers rather than forwarding them", () => {
    const result = applyRunPolicy(
        { prompt: 'hi', selectedSkillIds: ['secret-skill'], selectedMcpServerIds: ['host-crm'], hitlAnswers: { a: 'b' } },
        CALLER
    );
    assert.equal(result.rejections.length, 0);
    assert.ok(!('selectedSkillIds' in result.request!));
    assert.ok(!('selectedMcpServerIds' in result.request!));
    assert.ok(!('hitlAnswers' in result.request!));
    // …and says so, rather than silently ignoring them.
    assert.ok(result.applied.some((a) => a.includes('selectedSkillIds')));
});

test('an unknown field is dropped, not forwarded', () => {
    // A new upstream option must not become a new remote capability just because Cephable shipped it.
    const result = applyRunPolicy({ prompt: 'hi', someFutureEscapeHatch: true }, CALLER);
    assert.ok(!('someFutureEscapeHatch' in result.request!));
    assert.ok(result.applied.some((a) => a.includes('someFutureEscapeHatch')));
});

test('caps timeoutMs to the caller ceiling, and never past the absolute maximum', () => {
    const capped = applyRunPolicy({ prompt: 'hi', timeoutMs: 900_000 }, CALLER);
    assert.equal(capped.request!.timeoutMs, 120_000);
    assert.ok(capped.applied.some((a) => a.includes('capped')));

    const generous = applyRunPolicy({ prompt: 'hi', timeoutMs: 900_000 }, { ...CALLER, maxTimeoutMs: 999_999_999 });
    assert.equal(generous.request!.timeoutMs, ABSOLUTE_MAX_TIMEOUT_MS);
});

test('strips trace and events, which carry host context and bulk', () => {
    const result = applyRunPolicy({ prompt: 'hi', include: { trace: true, events: true } }, CALLER);
    assert.deepEqual(result.request!.include, { steps: true, trace: false, events: false });
});

test('rejects an empty or oversized prompt', () => {
    assert.ok(applyRunPolicy({ prompt: '   ' }, CALLER).rejections.some((r) => r.field === 'prompt'));
    assert.ok(applyRunPolicy({ prompt: 'x'.repeat(8001) }, CALLER).rejections.some((r) => r.field === 'prompt'));
});

// ── response sanitisation ──────────────────────────────────────────────────

test('the run record loses every host path before it goes back over the wire', () => {
    const sanitized = sanitizeRunRecord(
        completedRecord({
            steps: [
                {
                    index: 0,
                    title: 'Write a file',
                    status: 'success',
                    toolName: 'write_user_file',
                    toolArgs: { path: 'C:\\Users\\host\\Documents\\secret.md' },
                    producedFilePath: 'C:\\Users\\host\\Documents\\secret.md',
                    producedContent: 'the entire contents of a private file',
                    resultSummary: 'Wrote to C:\\Users\\host\\…',
                },
            ],
            trace: [{ role: 'system', content: 'host context' }],
            events: [{ channel: 'workflow-steps' }],
        })
    );

    const serialized = JSON.stringify(sanitized);
    assert.ok(!serialized.includes('C:\\\\Users\\\\host'), 'leaked a host path');
    assert.ok(!serialized.includes('secret.md'), 'leaked a file name');
    assert.ok(!serialized.includes('private file'), 'leaked file content');
    assert.ok(!serialized.includes('host context'), 'leaked the model trace');

    // …while keeping what a caller legitimately needs.
    assert.equal(sanitized.answer, 'done');
    assert.equal((sanitized.steps as unknown[]).length, 1);
    assert.deepEqual(sanitized.steps, [{ index: 0, title: 'Write a file', status: 'success', toolName: 'write_user_file' }]);
});

test('the run record does not report the host app version, model or hardware', () => {
    const sanitized = sanitizeRunRecord(completedRecord());
    for (const field of ['model', 'appVersion', 'backend', 'trace', 'events']) {
        assert.ok(!(field in sanitized), `expected ${field} to be withheld`);
    }
});

test('a parked run keeps the fields a caller needs to resume it', () => {
    const sanitized = sanitizeRunRecord(
        completedRecord({
            status: 'awaiting_tool_results',
            toolCalls: [{ id: 'c1', name: 'lookup', arguments: { id: '1' } }],
            resumeToken: 'tok-1',
        })
    );
    assert.equal(sanitized.status, 'awaiting_tool_results');
    assert.equal(sanitized.resumeToken, 'tok-1');
    assert.equal((sanitized.toolCalls as unknown[]).length, 1);
});

// ── auth ───────────────────────────────────────────────────────────────────

test('authenticates a known key and rejects everything else', () => {
    assert.equal(authenticate(CONFIG, KEY)?.id, 'test');
    assert.equal(authenticate(CONFIG, OTHER_KEY)?.id, 'other');
    assert.equal(authenticate(CONFIG, generateKey()), null);
    assert.equal(authenticate(CONFIG, ''), null);
    assert.equal(authenticate(CONFIG, undefined), null);
});

test('bearerFrom accepts only a well-formed header', () => {
    assert.equal(bearerFrom('Bearer abc'), 'abc');
    assert.equal(bearerFrom('bearer abc'), undefined);
    assert.equal(bearerFrom('Basic abc'), undefined);
    assert.equal(bearerFrom('Bearer  '), undefined);
    assert.equal(bearerFrom(undefined), undefined);
});

// ── HTTP surface ───────────────────────────────────────────────────────────

test('every route except /healthz requires a gateway key', async () => {
    const { instance } = await app();
    for (const url of ['/v1/status', '/v1/runs', '/v1/runs/cancel']) {
        const response = await instance.inject({ method: url === '/v1/status' ? 'GET' : 'POST', url });
        assert.equal(response.statusCode, 401, `${url} should require auth`);
    }
    assert.equal((await instance.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
    await instance.close();
});

test('/healthz reveals nothing about the host', async () => {
    const { instance } = await app();
    const response = await instance.inject({ method: 'GET', url: '/healthz' });
    assert.deepEqual(response.json(), { status: 'ok' });
    await instance.close();
});

test('/v1/status does not leak the host CPU or workspace path', async () => {
    const { instance } = await app();
    const response = await instance.inject({ method: 'GET', url: '/v1/status', headers: auth() });
    const body = JSON.stringify(response.json());
    assert.ok(!body.includes('SECRET CPU'));
    assert.ok(!body.includes('secret'));
    assert.equal(response.json().assistant.ready, true);
    await instance.close();
});

test('a policy violation is a 400 that names the field and the reason', async () => {
    const { instance, upstream } = await app();
    const response = await instance.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: auth(),
        payload: { prompt: 'hi', allowDestructiveTools: true },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.type, 'policy_violation');
    assert.equal(response.json().error.rejections[0].field, 'allowDestructiveTools');
    // Nothing reached the host.
    assert.equal(upstream.calls.length, 0);
    await instance.close();
});

test('an accepted run forwards the rewritten request, not the original', async () => {
    const { instance, upstream } = await app();
    const response = await instance.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: auth(),
        payload: { prompt: '  summarize this  ', timeoutMs: 900_000, include: { events: true } },
    });

    assert.equal(response.statusCode, 200);
    const [, forwarded] = upstream.calls[0].args as [string, Record<string, unknown>];
    assert.equal(forwarded.prompt, 'summarize this');
    assert.equal(forwarded.timeoutMs, 120_000);
    assert.equal(forwarded.restrictToWorkspace, true);
    assert.deepEqual(forwarded.include, { steps: true, trace: false, events: false });
    assert.match(response.headers['x-gateway-policy'] as string, /restrictToWorkspace forced on/);
    await instance.close();
});

test('a parked run comes back as 200 with a resume token', async () => {
    const upstream = stubUpstream({
        startRun: completedRecord({
            status: 'awaiting_tool_results',
            toolCalls: [{ id: 'c1', name: 'lookup', arguments: {} }],
            resumeToken: 'tok-1',
        }),
    });
    const { instance } = await app(upstream);

    const response = await instance.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: auth(),
        payload: { prompt: 'use my tool', clientTools: [{ name: 'lookup', description: 'x' }] },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'awaiting_tool_results');
    assert.equal(response.json().resumeToken, 'tok-1');
    await instance.close();
});

test("one caller cannot resume another caller's parked run", async () => {
    const upstream = stubUpstream({
        startRun: completedRecord({
            status: 'awaiting_tool_results',
            toolCalls: [{ id: 'c1', name: 'lookup', arguments: {} }],
            resumeToken: 'tok-1',
        }),
    });
    const { instance } = await app(upstream);

    // Caller "test" starts and parks a run.
    await instance.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: auth(KEY),
        payload: { prompt: 'mine', clientTools: [{ name: 'lookup', description: 'x' }] },
    });

    // Caller "other" tries to drive it.
    const stolen = await instance.inject({
        method: 'POST',
        url: '/v1/runs/tok-1/tool-results',
        headers: auth(OTHER_KEY),
        payload: { results: [{ id: 'c1', result: 'injected' }] },
    });
    assert.equal(stolen.statusCode, 404);

    // The rightful owner still can.
    const own = await instance.inject({
        method: 'POST',
        url: '/v1/runs/tok-1/tool-results',
        headers: auth(KEY),
        payload: { results: [{ id: 'c1', result: 'fine' }] },
    });
    assert.equal(own.statusCode, 200);
    await instance.close();
});

test('a malformed resume body is a 400', async () => {
    const { instance } = await app();
    const response = await instance.inject({
        method: 'POST',
        url: '/v1/runs/tok-1/tool-results',
        headers: auth(),
        payload: { results: [{ result: 'no id' }] },
    });
    assert.equal(response.statusCode, 400);
    await instance.close();
});

test('a failed run relays as 500 with the record, not as a gateway error', async () => {
    const upstream = stubUpstream({
        startRun: completedRecord({ status: 'failed', errorCode: 'TOOL_TIMEOUT', answer: '' }),
    });
    const { instance } = await app(upstream);
    const response = await instance.inject({ method: 'POST', url: '/v1/runs', headers: auth(), payload: { prompt: 'hi' } });

    assert.equal(response.statusCode, 500);
    assert.equal(response.json().schemaVersion, 1);
    assert.equal(response.json().errorCode, 'TOOL_TIMEOUT');
    await instance.close();
});

test('the upstream routes we do not expose are 404, not proxied', async () => {
    const { instance } = await app();
    for (const url of ['/v1/automate/models/select', '/v1/chat/completions', '/v1/automate/cancel', '/health']) {
        const response = await instance.inject({ method: 'POST', url, headers: auth(), payload: {} });
        assert.equal(response.statusCode, 404, `${url} should not be exposed`);
    }
    await instance.close();
});

test('cancel only works when you have a run in flight', async () => {
    const { instance, upstream } = await app();
    const response = await instance.inject({ method: 'POST', url: '/v1/runs/cancel', headers: auth(), payload: {} });
    assert.equal(response.statusCode, 200);
    assert.equal((upstream.calls.at(-1)!.args as [string, boolean])[0], 'test');
    await instance.close();
});
