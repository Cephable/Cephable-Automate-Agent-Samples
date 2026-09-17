/**
 * This app's own tools — an incident-review assistant over its demo data.
 *
 * Two kinds, and the difference is the interesting part of this sample:
 *
 * * **Reads** (`list_incidents`, `get_incident`, `check_slo`) return data to the agent. Ordinary.
 * * **UI tools** (`render_timeline`, `draft_status_post`) have a side effect on the *page*. They return
 *   a short confirmation to the agent, and their real output is a data part pushed down the stream to
 *   the browser, which renders it.
 *
 * That second kind is what makes an agent feel like part of an app rather than a text box bolted to
 * one. The tool still executes on the server — the browser never talks to Cephable — but the effect
 * lands in the UI.
 */

import type { ClientToolDefinition } from './cephable.ts';
import incidents from '../data/incidents.json' with { type: 'json' };

interface Incident {
    id: string;
    title: string;
    severity: 'sev1' | 'sev2' | 'sev3';
    service: string;
    openedAt: string;
    resolvedAt: string | null;
    customerImpact: string;
    rootCause: string | null;
    sloBudgetBurnedPercent: number;
}

const ALL = incidents.incidents as Incident[];

/** What a UI tool asks the route to push to the browser. */
export type UiEffect =
    | { kind: 'timeline'; incidents: Incident[] }
    | { kind: 'draft'; title: string; body: string };

export interface ToolContext {
    /** Queue an effect for the route to stream to the browser after this tool returns. */
    emit(effect: UiEffect): void;
}

type Handler = (args: Record<string, any>, context: ToolContext) => unknown;

// ── handlers ──────────────────────────────────────────────────────────────────

const handlers: Record<string, Handler> = {
    list_incidents: ({ severity, openOnly }) => {
        let matches = ALL;
        if (severity) matches = matches.filter((i) => i.severity === String(severity).toLowerCase());
        if (openOnly) matches = matches.filter((i) => i.resolvedAt === null);
        if (matches.length === 0) {
            throw new Error(
                `No incidents match. Severities present: ${[...new Set(ALL.map((i) => i.severity))].join(', ')}.`
            );
        }
        // Deliberately a summary, not the full records: a small local model does better with a short
        // list it can then drill into than with everything at once.
        return matches.map((i) => ({
            id: i.id,
            title: i.title,
            severity: i.severity,
            service: i.service,
            open: i.resolvedAt === null,
        }));
    },

    get_incident: ({ id }) => {
        const incident = ALL.find((i) => i.id.toLowerCase() === String(id).trim().toLowerCase());
        if (!incident) {
            throw new Error(`No incident ${id}. Known ids: ${ALL.map((i) => i.id).join(', ')}.`);
        }
        return incident;
    },

    check_slo: ({ service }) => {
        const needle = String(service).trim().toLowerCase();
        const matches = ALL.filter((i) => i.service.toLowerCase() === needle);
        if (matches.length === 0) {
            throw new Error(
                `No service named ${service}. Known services: ${[...new Set(ALL.map((i) => i.service))].join(', ')}.`
            );
        }
        const burned = matches.reduce((total, i) => total + i.sloBudgetBurnedPercent, 0);
        return {
            service: matches[0]!.service,
            incidentCount: matches.length,
            sloBudgetBurnedPercent: Math.round(burned * 10) / 10,
            // Derived here rather than left to the model: the threshold is a business rule, and rules
            // belong in code where they can be tested.
            overBudget: burned > 100,
        };
    },

    render_timeline: ({ incident_ids }, context) => {
        const ids = Array.isArray(incident_ids) ? incident_ids.map(String) : [];
        const selected = ALL.filter((i) => ids.some((id) => id.toLowerCase() === i.id.toLowerCase()));
        if (selected.length === 0) {
            throw new Error(`None of those ids exist. Known ids: ${ALL.map((i) => i.id).join(', ')}.`);
        }
        selected.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
        context.emit({ kind: 'timeline', incidents: selected });
        // The agent gets a confirmation, not the payload. It does not need to re-read what it just drew.
        return `Rendered a timeline of ${selected.length} incident(s) in the user's browser.`;
    },

    draft_status_post: ({ title, body }, context) => {
        const heading = String(title ?? '').trim();
        const text = String(body ?? '').trim();
        if (!heading || !text) throw new Error('Both title and body are required.');
        context.emit({ kind: 'draft', title: heading, body: text });
        return `Put a draft titled "${heading}" on screen for the user to review and copy.`;
    },
};

export function handlerFor(name: string): Handler | undefined {
    return handlers[name];
}

// ── declarations ──────────────────────────────────────────────────────────────

/**
 * Passed straight through as `clientTools`. `parameters` reaches the agent verbatim — Cephable hands
 * JSON Schema to the model as-is — so the `enum`s below really do constrain it.
 */
export const CLIENT_TOOLS: ClientToolDefinition[] = [
    {
        name: 'list_incidents',
        description:
            'List incidents, optionally filtered by severity or to only those still open. Returns a ' +
            'short summary of each: id, title, severity, service, and whether it is open. Start here, ' +
            'then use get_incident for detail.',
        parameters: {
            type: 'object',
            properties: {
                severity: { type: 'string', enum: ['sev1', 'sev2', 'sev3'], description: 'Optional filter' },
                openOnly: { type: 'boolean', description: 'Only incidents with no resolved time' },
            },
        },
    },
    {
        name: 'get_incident',
        description:
            'Fetch one incident in full by id: timings, customer impact, root cause if known, and how ' +
            'much of the service SLO budget it burned.',
        parameters: {
            type: 'object',
            properties: { id: { type: 'string', description: 'Incident id, e.g. INC-204' } },
            required: ['id'],
        },
    },
    {
        name: 'check_slo',
        description:
            'Check a service SLO budget. Returns how many incidents it has had, the total percentage of ' +
            'error budget burned, and an overBudget flag. Call this before claiming a service is healthy.',
        parameters: {
            type: 'object',
            properties: { service: { type: 'string', description: 'Service name, e.g. checkout-api' } },
            required: ['service'],
        },
    },
    {
        name: 'render_timeline',
        description:
            "Draw a timeline of specific incidents in the user's browser, ordered by when they opened. " +
            'Use this when comparing incidents or showing a sequence — it is far easier to read than ' +
            'the same thing described in prose.',
        parameters: {
            type: 'object',
            properties: {
                incident_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Incident ids to include',
                },
            },
            required: ['incident_ids'],
        },
    },
    {
        name: 'draft_status_post',
        description:
            'Put a draft customer-facing status post on screen for the user to review and copy. Use it ' +
            'when the user asks for something to publish or send. Do not use it for your own analysis.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short headline' },
                body: { type: 'string', description: 'The post text, in plain language' },
            },
            required: ['title', 'body'],
        },
    },
];

export const SUGGESTED_PROMPTS = [
    'What is still broken right now, and which service is in the worst shape?',
    'Compare INC-204 and INC-207 on a timeline and tell me if they share a root cause.',
    'Draft a status post for the checkout-api outage that does not blame a vendor.',
    'Is payments-worker over its error budget? Show me the incidents that got it there.',
];
