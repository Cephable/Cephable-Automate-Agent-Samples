/**
 * Cephable as an AI SDK language model.
 *
 * The Automate server exposes an OpenAI-compatible `POST /v1/chat/completions`, so it drops
 * straight into `@ai-sdk/openai-compatible`. Everything downstream - ToolLoopAgent, the tool
 * loop, the approval flow - then works exactly as it would against a hosted provider.
 *
 * This module is server-only. The Automate server sends no CORS headers and has no OPTIONS
 * handler, so a fetch from a browser origin fails preflight - and the key has no business in
 * a browser bundle anyway.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { simulateStreamingMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';

const DEFAULT_PORT = 4317;
const PORT_ATTEMPTS = 12;

/** `GET /v1/models` reports exactly one id, and this is it. */
const MODEL_ID = 'cephable-agent';

export class CephableSetupError extends Error {}

function accessKey(): string {
    const key = process.env.CEPHABLE_AUTOMATE_KEY;
    if (!key) {
        throw new CephableSetupError(
            'CEPHABLE_AUTOMATE_KEY is not set. Copy it from Extensions -> Automate HTTP Server ' +
            'in the Cephable desktop app and put it in .env.local.',
        );
    }
    return key;
}

let cached: { endpoint: string; at: number } | null = null;

/**
 * Find the port Cephable actually bound. It prefers 4317 but walks up to 4328 when something
 * else holds the port, so hardcoding 4317 breaks the moment a second instance is running.
 */
export async function resolveEndpoint(): Promise<string> {
    const pinned = process.env.CEPHABLE_ENDPOINT;
    if (pinned) return pinned.replace(/\/+$/, '');

    // A short cache keeps every request in a conversation from re-sweeping the range.
    if (cached && Date.now() - cached.at < 30_000) return cached.endpoint;

    for (let i = 0; i < PORT_ATTEMPTS; i++) {
        const endpoint = `http://127.0.0.1:${DEFAULT_PORT + i}`;
        let response: Response;
        try {
            response = await fetch(`${endpoint}/health`, {
                headers: { Authorization: `Bearer ${accessKey()}` },
                signal: AbortSignal.timeout(800),
            });
        } catch {
            continue;   // nothing listening on this port
        }

        // A 401 means we found Cephable and the key is wrong. Keep sweeping and it looks like
        // "not running", which sends people to the wrong problem.
        if (response.status === 401) {
            throw new CephableSetupError(
                'Cephable rejected the access key. Copy it again from the extension detail view - ' +
                'regenerating it invalidates the old one immediately.',
            );
        }
        if (response.ok) {
            cached = { endpoint, at: Date.now() };
            return endpoint;
        }
    }

    throw new CephableSetupError(
        `No Cephable server answered on 127.0.0.1:${DEFAULT_PORT}-${DEFAULT_PORT + PORT_ATTEMPTS - 1}. ` +
        'Open the Cephable desktop app and enable Extensions -> Automate HTTP Server.',
    );
}

/**
 * The model the agent runs on.
 *
 * Cephable's `/v1/chat/completions` is deliberately non-streaming - a run is a whole agent
 * execution, not a token feed, so it answers once with the finished result. The AI SDK's UI
 * stream helpers call `agent.stream()`, which would otherwise fail with "Response stream ended
 * without a finish reason". `simulateStreamingMiddleware` bridges the two: it presents the
 * single response as a one-chunk stream, so the loop, the UI parts and the approval flow all
 * behave normally. The text simply arrives at once rather than typing itself out.
 */
export async function cephableModel(): Promise<LanguageModel> {
    const endpoint = await resolveEndpoint();
    const cephable = createOpenAICompatible({
        name: 'cephable',
        baseURL: `${endpoint}/v1`,
        apiKey: accessKey(),
    });
    return wrapLanguageModel({
        model: cephable(MODEL_ID),
        middleware: simulateStreamingMiddleware(),
    });
}
