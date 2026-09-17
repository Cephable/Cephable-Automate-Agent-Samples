'use client';

/**
 * The chat surface.
 *
 * `useChat` from `@ai-sdk/react` does the transport and message state. Everything Cephable-specific
 * arrives as typed data parts on the assistant message — tool calls, tool results, rendered timelines,
 * drafts, the step list, and the run footer — so rendering is just a switch over `part.type`.
 *
 * Parts arrive in the order the agent produced them, which means the UI reads as a transcript of what
 * actually happened rather than a summary written afterwards.
 */

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';
import type { CephableUIMessage } from '../app/api/chat/route.ts';
import { SUGGESTED_PROMPTS } from '../lib/tools.ts';

export function Chat() {
    const [input, setInput] = useState('');
    const { messages, sendMessage, status, error, stop } = useChat<CephableUIMessage>({
        transport: new DefaultChatTransport({ api: '/api/chat' }),
    });

    const running = status === 'submitted' || status === 'streaming';

    function submit(text: string) {
        const trimmed = text.trim();
        if (!trimmed || running) return;
        void sendMessage({ text: trimmed });
        setInput('');
    }

    return (
        <div className="chat">
            <div className="transcript">
                {messages.length === 0 && (
                    <div className="empty">
                        <h2>On-device incident review</h2>
                        <p>
                            The agent runs on this machine, inside Cephable. Its tools are this app&apos;s own
                            functions — incident queries, an SLO check, and two that draw straight into this
                            page. Nothing leaves the device.
                        </p>
                        <div className="suggestions">
                            {SUGGESTED_PROMPTS.map((prompt) => (
                                <button key={prompt} onClick={() => submit(prompt)} type="button">
                                    {prompt}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {messages.map((message) => (
                    <article key={message.id} className={`message ${message.role}`}>
                        <div className="who">{message.role === 'user' ? 'You' : 'Cephable'}</div>
                        <div className="parts">
                            {message.parts.map((part, index) => (
                                <Part key={`${message.id}-${index}`} part={part} />
                            ))}
                        </div>
                    </article>
                ))}

                {running && <div className="working">the agent is working…</div>}
                {error && <div className="notice error">{error.message}</div>}
            </div>

            <form
                className="composer"
                onSubmit={(event) => {
                    event.preventDefault();
                    submit(input);
                }}
            >
                <input
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder={running ? 'Waiting for the agent…' : 'Ask about the incidents…'}
                    disabled={running}
                    aria-label="Message"
                />
                {running ? (
                    <button type="button" onClick={() => stop()}>
                        Stop
                    </button>
                ) : (
                    <button type="submit" disabled={!input.trim()}>
                        Send
                    </button>
                )}
            </form>
        </div>
    );
}

/** One message part. The `data-*` cases are this app's own; `text` is the agent's answer. */
function Part({ part }: { part: CephableUIMessage['parts'][number] }) {
    switch (part.type) {
        case 'text':
            return <div className="text">{part.text}</div>;

        case 'data-run-started':
            return (
                <div className="run-header">
                    <span className="badge">on-device</span>
                    <span>{part.data.model ?? 'unknown model'}</span>
                    <span className={part.data.cpuFallback ? 'warn' : ''}>
                        {part.data.accelerator ?? '?'}
                        {part.data.cpuFallback ? ' (CPU fallback)' : ''}
                    </span>
                    {part.data.contextSize && <span>{part.data.contextSize.toLocaleString()} ctx</span>}
                </div>
            );

        case 'data-tool-call':
            return (
                <div className="tool-call">
                    <code>{part.data.name}</code>
                    <span className="args">{renderArgs(part.data.args)}</span>
                </div>
            );

        case 'data-tool-result':
            return (
                <div className={`tool-result ${part.data.failed ? 'failed' : ''}`}>
                    {part.data.failed ? '✗' : '✓'} {part.data.summary}
                </div>
            );

        case 'data-timeline':
            return <Timeline incidents={part.data.incidents} />;

        case 'data-draft':
            return <Draft title={part.data.title} body={part.data.body} />;

        case 'data-steps':
            return (
                <details className="steps">
                    <summary>{part.data.steps.length} agent steps</summary>
                    <ol>
                        {part.data.steps.map((step) => (
                            <li key={step.index} className={step.status}>
                                {step.title}
                                {step.toolName && <code>{step.toolName}</code>}
                            </li>
                        ))}
                    </ol>
                </details>
            );

        case 'data-run-finished':
            return (
                <div className="run-footer">
                    <span className={part.data.status === 'completed' ? '' : 'warn'}>
                        {part.data.status}
                        {part.data.errorCode ? ` (${part.data.errorCode})` : ''}
                    </span>
                    <span>{(part.data.durationMs / 1000).toFixed(1)}s</span>
                    {part.data.outputTokens !== undefined && <span>{part.data.outputTokens} tokens out</span>}
                    {part.data.tps !== undefined && <span>{part.data.tps.toFixed(1)} tok/s</span>}
                </div>
            );

        case 'data-notice':
            return <div className={`notice ${part.data.level}`}>{part.data.message}</div>;

        default:
            return null;
    }
}

/** One of the two "the agent drew this" tools. */
function Timeline({ incidents }: { incidents: Array<Record<string, any>> }) {
    return (
        <div className="timeline">
            <div className="timeline-title">Timeline</div>
            {incidents.map((incident) => (
                <div key={String(incident.id)} className={`event ${incident.severity}`}>
                    <div className="when">{formatTime(String(incident.openedAt))}</div>
                    <div className="what">
                        <strong>
                            {String(incident.id)} · {String(incident.title)}
                        </strong>
                        <div className="meta">
                            {String(incident.service)} · {String(incident.severity)} ·{' '}
                            {incident.resolvedAt
                                ? `resolved ${formatTime(String(incident.resolvedAt))}`
                                : 'still open'}
                        </div>
                        {incident.rootCause && <div className="cause">{String(incident.rootCause)}</div>}
                    </div>
                </div>
            ))}
        </div>
    );
}

function Draft({ title, body }: { title: string; body: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="draft">
            <div className="draft-head">
                <strong>{title}</strong>
                <button
                    type="button"
                    onClick={() => {
                        void navigator.clipboard.writeText(`${title}\n\n${body}`).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                        });
                    }}
                >
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>
            <p>{body}</p>
        </div>
    );
}

function renderArgs(args: Record<string, unknown>): string {
    const entries = Object.entries(args);
    if (entries.length === 0) return '()';
    return `(${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')})`;
}

function formatTime(iso: string): string {
    try {
        return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    } catch {
        return iso;
    }
}
