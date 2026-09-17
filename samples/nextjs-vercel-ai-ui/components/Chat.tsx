'use client';

/**
 * The chat surface, built from Vercel's AI Elements components.
 *
 * Almost nothing here is bespoke. `useChat` handles transport and message state, and AI Elements
 * supplies the transcript (`Conversation`), the bubbles (`Message`), the markdown renderer
 * (`MessageResponse`), the collapsible tool cards (`Tool`), the step list (`Task`) and the composer
 * (`PromptInput`). The route emits the SDK's own `tool-*` chunks, so a Cephable tool call renders
 * through `<Tool>` with no translation layer at all.
 *
 * What is left to write is the genuinely Cephable-specific part: the local-runtime header, and the two
 * tools whose output is UI rather than data.
 */

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { Cpu, FileText, GitCommitVertical, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import {
    Conversation,
    ConversationContent,
    ConversationEmptyState,
    ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
    PromptInput,
    PromptInputBody,
    PromptInputFooter,
    PromptInputSubmit,
    PromptInputTextarea,
    type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { Task, TaskItem, TaskTrigger, TaskContent } from '@/components/ai-elements/task';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CephableUIMessage } from '@/app/api/chat/route';
import { SUGGESTED_PROMPTS } from '@/lib/tools';

export function Chat() {
    const { messages, sendMessage, status, error, stop } = useChat<CephableUIMessage>({
        transport: new DefaultChatTransport({ api: '/api/chat' }),
    });

    const running = status === 'submitted' || status === 'streaming';

    function submit(text: string) {
        const trimmed = text.trim();
        if (!trimmed || running) return;
        void sendMessage({ text: trimmed });
    }

    return (
        <div className="flex h-[calc(100vh-11rem)] flex-col gap-4">
            <Conversation className="min-h-0 flex-1">
                <ConversationContent>
                    {messages.length === 0 && (
                        <ConversationEmptyState
                            icon={<ShieldCheck className="size-5" />}
                            title="On-device incident review"
                            description="The agent runs on this machine, inside Cephable. Its tools are this app's own functions — and two of them draw straight into this page. Nothing leaves the device."
                        >
                            <div className="mt-4 flex w-full max-w-xl flex-col gap-2">
                                {SUGGESTED_PROMPTS.map((prompt) => (
                                    <Button
                                        key={prompt}
                                        // Explicitly not a submit button: shadcn's Button leaves `type`
                                        // unset, which the browser treats as submit, so dropping this
                                        // into any surrounding form would reload the page.
                                        type="button"
                                        variant="outline"
                                        className="h-auto w-full justify-start whitespace-normal py-2 text-left text-sm"
                                        onClick={() => submit(prompt)}
                                    >
                                        {prompt}
                                    </Button>
                                ))}
                            </div>
                        </ConversationEmptyState>
                    )}

                    {messages.map((message) => (
                        <Message from={message.role} key={message.id}>
                            <MessageContent>
                                {message.parts.map((part, index) => (
                                    <Part key={`${message.id}-${index}`} part={part} />
                                ))}
                            </MessageContent>
                        </Message>
                    ))}
                </ConversationContent>
                <ConversationScrollButton />
            </Conversation>

            {error && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
                    {error.message}
                </div>
            )}

            <PromptInput
                onSubmit={(message: PromptInputMessage) => submit(message.text)}
                className="shrink-0"
            >
                <PromptInputBody>
                    <PromptInputTextarea
                        placeholder={running ? 'Waiting for the agent…' : 'Ask about the incidents…'}
                        disabled={running}
                    />
                </PromptInputBody>
                <PromptInputFooter>
                    <span className="pl-1 text-muted-foreground text-xs">
                        Runs on this machine. No prompt leaves the device.
                    </span>
                    <PromptInputSubmit status={status} onStop={stop} />
                </PromptInputFooter>
            </PromptInput>
        </div>
    );
}

/**
 * One message part.
 *
 * `dynamic-tool` is the SDK's own tool part, so it goes straight into AI Elements' `<Tool>`. The
 * `data-*` cases are this app's.
 */
function Part({ part }: { part: CephableUIMessage['parts'][number] }) {
    switch (part.type) {
        case 'text':
            // Streamdown-backed markdown, so the agent's lists and emphasis render properly.
            return <MessageResponse>{part.text}</MessageResponse>;

        case 'dynamic-tool':
            return (
                <Tool defaultOpen={part.state === 'output-error'}>
                    <ToolHeader type="dynamic-tool" toolName={part.toolName} state={part.state} />
                    <ToolContent>
                        <ToolInput input={part.input} />
                        <ToolOutput output={part.output} errorText={part.errorText} />
                    </ToolContent>
                </Tool>
            );

        case 'data-run-started':
            return (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="secondary" className="gap-1">
                        <Cpu className="size-3" />
                        on-device
                    </Badge>
                    <span className="font-mono text-muted-foreground">
                        {part.data.model ?? 'unknown model'}
                    </span>
                    <span
                        className={
                            part.data.cpuFallback
                                ? 'font-mono text-destructive'
                                : 'font-mono text-muted-foreground'
                        }
                    >
                        {part.data.accelerator ?? '?'}
                        {part.data.cpuFallback ? ' (CPU fallback)' : ''}
                    </span>
                    {part.data.contextSize && (
                        <span className="font-mono text-muted-foreground">
                            {part.data.contextSize.toLocaleString()} ctx
                        </span>
                    )}
                </div>
            );

        case 'data-timeline':
            return <Timeline incidents={part.data.incidents} />;

        case 'data-draft':
            return <Draft body={part.data.body} title={part.data.title} />;

        case 'data-steps':
            return (
                <Task className="w-full" defaultOpen={false}>
                    <TaskTrigger title={`${part.data.steps.length} agent steps`} />
                    <TaskContent>
                        {part.data.steps.map((step) => (
                            <TaskItem key={step.index}>
                                <span className={step.status === 'failed' ? 'text-destructive' : ''}>
                                    {step.title}
                                </span>
                                {step.toolName && (
                                    <span className="ml-2 font-mono text-xs opacity-70">{step.toolName}</span>
                                )}
                            </TaskItem>
                        ))}
                    </TaskContent>
                </Task>
            );

        case 'data-run-finished':
            return (
                <div className="flex flex-wrap items-center gap-3 font-mono text-muted-foreground text-xs">
                    <span className={part.data.status === 'completed' ? '' : 'text-destructive'}>
                        {part.data.status}
                        {part.data.errorCode ? ` (${part.data.errorCode})` : ''}
                    </span>
                    <span>{(part.data.durationMs / 1000).toFixed(1)}s</span>
                    {part.data.outputTokens !== undefined && <span>{part.data.outputTokens} tokens out</span>}
                    {part.data.tps !== undefined && <span>{part.data.tps.toFixed(1)} tok/s</span>}
                </div>
            );

        case 'data-notice':
            return (
                <div
                    className={
                        part.data.level === 'error'
                            ? 'rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm'
                            : 'rounded-lg bg-muted px-3 py-2 text-sm'
                    }
                >
                    {part.data.message}
                </div>
            );

        default:
            return null;
    }
}

/** The payload of `render_timeline` — a tool whose output is UI rather than data. */
function Timeline({ incidents }: { incidents: Array<Record<string, any>> }) {
    return (
        <div className="w-full rounded-lg border bg-card p-3">
            <div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wide">
                <GitCommitVertical className="size-3.5" />
                Timeline
            </div>
            <ol className="divide-y">
                {incidents.map((incident) => (
                    <li className="grid gap-1 py-2 sm:grid-cols-[10rem_1fr] sm:gap-3" key={String(incident.id)}>
                        <span className="font-mono text-muted-foreground text-xs">
                            {formatTime(String(incident.openedAt))}
                        </span>
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-sm">
                                    {String(incident.id)} · {String(incident.title)}
                                </span>
                                <Badge
                                    variant={incident.severity === 'sev1' ? 'destructive' : 'secondary'}
                                    className="text-[10px]"
                                >
                                    {String(incident.severity)}
                                </Badge>
                            </div>
                            <div className="text-muted-foreground text-xs">
                                {String(incident.service)} ·{' '}
                                {incident.resolvedAt
                                    ? `resolved ${formatTime(String(incident.resolvedAt))}`
                                    : 'still open'}
                            </div>
                            {incident.rootCause && (
                                <p className="mt-1 text-sm">{String(incident.rootCause)}</p>
                            )}
                        </div>
                    </li>
                ))}
            </ol>
        </div>
    );
}

/** The payload of `draft_status_post`. */
function Draft({ title, body }: { title: string; body: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="w-full rounded-lg border border-primary/40 bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 font-medium text-sm">
                    <FileText className="size-3.5" />
                    {title}
                </span>
                <Button
                    onClick={() => {
                        void navigator.clipboard.writeText(`${title}\n\n${body}`).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                        });
                    }}
                    size="sm"
                    variant="secondary"
                >
                    {copied ? 'Copied' : 'Copy'}
                </Button>
            </div>
            <p className="whitespace-pre-wrap text-sm">{body}</p>
        </div>
    );
}

function formatTime(iso: string): string {
    try {
        return `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)}Z`;
    } catch {
        return iso;
    }
}
