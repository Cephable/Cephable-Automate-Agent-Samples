'use client';

/**
 * The browser half. Two things are worth reading here:
 *
 *  1. Tool parts arrive as `tool-<name>` UI parts with a `state`, so the page can show a tool
 *     running before it has a result.
 *  2. When a tool needs approval the part reaches `approval-requested`, and nothing proceeds
 *     until `addToolApprovalResponse` is called. That is a real gate, not a confirmation
 *     dialog painted after the fact - the server is genuinely suspended.
 */
import { useChat } from '@ai-sdk/react';
import { isToolUIPart, getToolName } from 'ai';
import { useState } from 'react';

export function Agent() {
    const { messages, sendMessage, addToolApprovalResponse, status, error } = useChat();
    const [input, setInput] = useState('');
    const busy = status === 'submitted' || status === 'streaming';

    return (
        <div className="flex flex-1 flex-col gap-4">
            <div className="flex flex-1 flex-col gap-4">
                {messages.map((message) => (
                    <div key={message.id} className="flex flex-col gap-2">
                        {message.parts.map((part, index) => {
                            const key = `${message.id}-${index}`;

                            if (part.type === 'text') {
                                const mine = message.role === 'user';
                                return (
                                    <div
                                        key={key}
                                        className={
                                            mine
                                                ? 'self-end rounded-2xl rounded-br-sm bg-slate-900 px-4 py-2.5 text-sm text-white'
                                                : 'self-start rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-4 py-2.5 text-sm leading-relaxed text-slate-800'
                                        }
                                    >
                                        {part.text}
                                    </div>
                                );
                            }

                            if (isToolUIPart(part)) {
                                const name = getToolName(part);

                                if (part.state === 'approval-requested') {
                                    return (
                                        <div
                                            key={key}
                                            className="self-start rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm"
                                        >
                                            <p className="font-semibold text-amber-900">
                                                {name} needs your approval
                                            </p>
                                            <pre className="mt-2 overflow-x-auto rounded-lg bg-white/70 p-2 text-xs text-slate-700">
                                                {JSON.stringify(part.input, null, 2)}
                                            </pre>
                                            <div className="mt-3 flex gap-2">
                                                <button
                                                    type="button"
                                                    className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-amber-950"
                                                    onClick={() =>
                                                        addToolApprovalResponse({
                                                            id: part.approval.id,
                                                            approved: true,
                                                        })
                                                    }
                                                >
                                                    Approve
                                                </button>
                                                <button
                                                    type="button"
                                                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700"
                                                    onClick={() =>
                                                        addToolApprovalResponse({
                                                            id: part.approval.id,
                                                            approved: false,
                                                            reason: 'Declined by the agent on duty.',
                                                        })
                                                    }
                                                >
                                                    Reject
                                                </button>
                                            </div>
                                        </div>
                                    );
                                }

                                return (
                                    <div
                                        key={key}
                                        className="self-start rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-600"
                                    >
                                        <span className="font-bold text-sky-700">{name}</span>
                                        <span className="ml-2 text-slate-400">{part.state}</span>
                                        {'output' in part && part.output !== undefined ? (
                                            <pre className="mt-1.5 overflow-x-auto text-[11px] text-slate-500">
                                                {JSON.stringify(part.output, null, 2)}
                                            </pre>
                                        ) : null}
                                    </div>
                                );
                            }

                            return null;
                        })}
                    </div>
                ))}
            </div>

            {error ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                    {error.message}
                </p>
            ) : null}

            <form
                className="sticky bottom-4 flex gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm"
                onSubmit={(event) => {
                    event.preventDefault();
                    const text = input.trim();
                    if (!text || busy) return;
                    setInput('');
                    void sendMessage({ text });
                }}
            >
                <input
                    className="flex-1 bg-transparent px-3 py-2 text-sm outline-none"
                    placeholder="Ask about an order&hellip;"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                />
                <button
                    type="submit"
                    disabled={busy}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
                >
                    {busy ? 'Working' : 'Send'}
                </button>
            </form>
        </div>
    );
}
