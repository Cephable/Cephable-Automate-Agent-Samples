/**
 * The agent loop.
 *
 * `ToolLoopAgent` owns the loop: it calls the model, executes any tools the model asks for,
 * feeds the results back, and repeats until a stop condition is met. Cephable is the model
 * behind it - so you get Cephable's on-device agent as the reasoning engine, while the loop,
 * the tools and the approval policy stay in your code.
 *
 * Contrast with the nextjs-vercel-ai-ui sample, which lets Cephable run its own loop and just
 * renders the steps. Both are valid; this one is the right shape when the tools and the
 * guardrails are yours.
 */
import { ToolLoopAgent, createAgentUIStreamResponse, stepCountIs, type InferAgentUIMessage } from 'ai';
import { cephableModel, CephableSetupError } from '@/lib/cephable';
import { tools } from '@/lib/tools';

// The agent runs on the local machine, so it must not be pushed to an edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 300;

function buildAgent(model: Awaited<ReturnType<typeof cephableModel>>) {
    return new ToolLoopAgent({
        model,
        tools,
        instructions: [
            'You are the support desk assistant for a logistics company.',
            'Use the tools to look things up rather than guessing; you have no memory of the order book.',
            'Before refunding anything, state the amount and why, and expect a human to approve it.',
            'Answer in two or three sentences. Do not list your steps back to the user.',
        ].join(' '),
        // Without a stop condition a tool loop can run until the context window gives out.
        // Eight steps is comfortably more than this task needs and still bounded.
        stopWhen: stepCountIs(8),
    });
}

export type AgentUIMessage = InferAgentUIMessage<ReturnType<typeof buildAgent>>;

export async function POST(request: Request) {
    const { messages } = (await request.json()) as { messages: unknown[] };

    let model: Awaited<ReturnType<typeof cephableModel>>;
    try {
        model = await cephableModel();
    } catch (error) {
        // Setup problems are the common case in a sample, so say what to do rather than 500ing.
        const message = error instanceof CephableSetupError ? error.message : String(error);
        return Response.json({ error: message }, { status: 503 });
    }

    return createAgentUIStreamResponse({
        agent: buildAgent(model),
        uiMessages: messages,
        onError: (error) => (error instanceof Error ? error.message : String(error)),
    });
}
