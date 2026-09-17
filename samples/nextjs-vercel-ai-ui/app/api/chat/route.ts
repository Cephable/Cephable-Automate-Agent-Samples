/**
 * The route handler: Cephable's park/resume loop, streamed into the Vercel AI SDK.
 *
 * Cephable does not stream — `/v1/runs` blocks until the run reaches a terminal state. But the
 * park/resume loop gives genuinely incremental events: every time the agent calls one of our tools, the
 * run parks, the HTTP request returns, we execute the tool, and we resume. That is a real sequence of
 * things happening, so this route writes each one into a `UIMessageStream` as it lands.
 *
 * The result is a UI that fills in as the agent works, without pretending to stream tokens it does not
 * have. What you see is what actually happened, in the order it happened.
 */

import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import {
    CephableError,
    cancelRun,
    resumeRun,
    startRun,
    waitUntilReady,
    type CephableRunRecord,
    type CephableStep,
} from '../../../lib/cephable.ts';
import { CLIENT_TOOLS, handlerFor, type UiEffect } from '../../../lib/tools.ts';

/**
 * Custom data parts, for the things the AI SDK has no first-class shape for.
 *
 * Tool calls are deliberately *not* here: they go out as the SDK's own `tool-*` chunks, which become
 * `dynamic-tool` parts on the message and render through AI Elements' `<Tool>` component with no
 * translation. Only what is genuinely Cephable-specific — the local runtime header, the two UI-effect
 * payloads, the agent's own step list, and the run footer — needs a custom part.
 */
export type CephableDataParts = {
    'run-started': {
        requestId: string;
        model: string | null;
        accelerator: string | null;
        cpuFallback: boolean;
        contextSize: number | null;
        appVersion: string;
    };
    'timeline': { incidents: Array<Record<string, unknown>> };
    'draft': { title: string; body: string };
    'steps': { steps: CephableStep[] };
    'run-finished': {
        status: string;
        errorCode?: string;
        durationMs: number;
        inputTokens?: number;
        outputTokens?: number;
        tps?: number;
    };
    'notice': { level: 'info' | 'error'; message: string };
};

export type CephableUIMessage = UIMessage<never, CephableDataParts>;

/** Node runtime, not edge: this talks to 127.0.0.1, which only exists on the machine running Cephable. */
export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_TOOL_ROUNDS = 20;

export async function POST(request: Request) {
    const body = (await request.json()) as { messages?: CephableUIMessage[] };
    const prompt = latestUserText(body.messages ?? []);

    if (!prompt) {
        return Response.json({ error: 'No user message to run.' }, { status: 400 });
    }

    const stream = createUIMessageStream<CephableUIMessage>({
        execute: async ({ writer }) => {
            const textId = 'answer';
            let record: CephableRunRecord;

            // `start` and `finish` are written by hand: as of ai v7 `createUIMessageStream` no longer
            // injects them, and without a `start` the client never opens an assistant message — so
            // every part below would stream correctly and render nowhere.
            writer.write({ type: 'start' });

            // Gate on readiness rather than firing into a 409. The inference slot is shared with the
            // person using the Cephable app, so "busy" is a normal state, not an error.
            try {
                const health = await waitUntilReady(60_000);
                record = await startRun({ prompt, clientTools: CLIENT_TOOLS });
                writer.write({
                    type: 'data-run-started',
                    id: 'run',
                    data: {
                        requestId: record.requestId,
                        model: health.modelName,
                        accelerator: health.backend?.accelerator ?? null,
                        cpuFallback: health.backend?.cpuFallback ?? false,
                        contextSize: health.contextSize,
                        appVersion: health.appVersion,
                    },
                });
            } catch (error) {
                writer.write({
                    type: 'data-notice',
                    data: { level: 'error', message: describe(error) },
                });
                writer.write({ type: 'finish' });
                return;
            }

            // ── the park/resume loop ────────────────────────────────────────────
            try {
                let rounds = 0;
                while (record.status === 'awaiting_tool_results') {
                    if (++rounds > MAX_TOOL_ROUNDS) {
                        // A model looping on one tool would otherwise hold the machine's only
                        // inference slot until the run's own timeout.
                        await cancelRun(true).catch(() => {});
                        writer.write({
                            type: 'data-notice',
                            data: {
                                level: 'error',
                                message: `The agent asked for tools ${MAX_TOOL_ROUNDS} times without settling. Run cancelled.`,
                            },
                        });
                        writer.write({ type: 'finish' });
                        return;
                    }

                    const results: Array<{ id: string; result?: unknown; error?: string }> = [];

                    for (const call of record.toolCalls ?? []) {
                        // The SDK's own tool chunks, marked `dynamic` because these tools are declared
                        // per run rather than in a static ToolSet. They arrive on the message as a
                        // `dynamic-tool` part that AI Elements' <Tool> renders directly.
                        writer.write({
                            type: 'tool-input-available',
                            toolCallId: call.id,
                            toolName: call.name,
                            input: call.arguments ?? {},
                            dynamic: true,
                        });

                        // UI tools queue an effect rather than returning it, so the browser gets the
                        // payload and the agent only gets a confirmation.
                        const effects: UiEffect[] = [];
                        const handler = handlerFor(call.name);

                        if (!handler) {
                            const message = `No handler is registered for ${call.name}`;
                            results.push({ id: call.id, error: message });
                            writer.write({
                                type: 'tool-output-error',
                                toolCallId: call.id,
                                errorText: message,
                                dynamic: true,
                            });
                            continue;
                        }

                        try {
                            const output = handler(call.arguments ?? {}, { emit: (e) => effects.push(e) });
                            results.push({ id: call.id, result: output });

                            for (const effect of effects) {
                                if (effect.kind === 'timeline') {
                                    writer.write({
                                        type: 'data-timeline',
                                        id: `${call.id}-timeline`,
                                        data: { incidents: effect.incidents as unknown as Array<Record<string, unknown>> },
                                    });
                                } else {
                                    writer.write({
                                        type: 'data-draft',
                                        id: `${call.id}-draft`,
                                        data: { title: effect.title, body: effect.body },
                                    });
                                }
                            }

                            writer.write({
                                type: 'tool-output-available',
                                toolCallId: call.id,
                                output,
                                dynamic: true,
                            });
                        } catch (error) {
                            // Reported to the agent as a failed tool call, not thrown. It then adapts
                            // or explains, which beats a dead run.
                            const message = error instanceof Error ? error.message : String(error);
                            results.push({ id: call.id, error: message });
                            writer.write({
                                type: 'tool-output-error',
                                toolCallId: call.id,
                                errorText: message,
                                dynamic: true,
                            });
                        }
                    }

                    record = await resumeRun(record.resumeToken!, results);
                }

                // ── the answer ──────────────────────────────────────────────────
                const answer = record.finalAnswer || record.answer || '(the agent returned no text)';
                writer.write({ type: 'text-start', id: textId });
                writer.write({ type: 'text-delta', id: textId, delta: answer });
                writer.write({ type: 'text-end', id: textId });

                if (record.steps?.length) {
                    writer.write({ type: 'data-steps', id: 'steps', data: { steps: record.steps } });
                }
                writer.write({
                    type: 'data-run-finished',
                    id: 'finished',
                    data: {
                        status: record.status,
                        errorCode: record.errorCode,
                        durationMs: record.durationMs,
                        inputTokens: record.usage?.inputTokens,
                        outputTokens: record.usage?.outputTokens,
                        tps: record.usage?.tps,
                    },
                });
            } catch (error) {
                // Our request dying does not stop the run — it keeps going inside Cephable and holds
                // the slot. Cancel it before giving up.
                await cancelRun(true).catch(() => {});
                writer.write({ type: 'data-notice', data: { level: 'error', message: describe(error) } });
            }

            writer.write({ type: 'finish' });
        },
        onError: (error) => describe(error),
    });

    return createUIMessageStreamResponse({ stream });
}

function latestUserText(messages: CephableUIMessage[]): string | null {
    // Only the last user turn: Cephable owns conversation state itself, and this sample deliberately
    // sends self-contained prompts rather than using `continuation` (which would also pick up whatever
    // the person at the machine was doing in the app's own panel).
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user') continue;
        const text = message.parts
            .filter((part) => part.type === 'text')
            .map((part) => (part as { text: string }).text)
            .join('\n')
            .trim();
        if (text) return text;
    }
    return null;
}

function summarize(output: unknown): string {
    if (typeof output === 'string') return output.length > 160 ? `${output.slice(0, 157)}…` : output;
    if (Array.isArray(output)) return `${output.length} result(s)`;
    if (output && typeof output === 'object') return Object.keys(output).join(', ');
    return String(output);
}

function describe(error: unknown): string {
    if (error instanceof CephableError) {
        if (error.isBusy) {
            return (
                'Cephable is busy with another run. It has one inference slot, shared with the app\'s own ' +
                'AI Workflows panel — wait for that to finish, or stop it in the app.'
            );
        }
        return error.message;
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
        return 'The run took longer than this app allows. It may still be finishing inside Cephable.';
    }
    return error instanceof Error ? error.message : String(error);
}
