/**
 * The app's own tools.
 *
 * These run here, in this Next.js server, against this app's data. Cephable never sees the
 * order book - it only ever sees the tool's name, its JSON Schema, and whatever the execute
 * function chooses to return.
 *
 * `issue_refund` is marked `needsApproval`, which is the interesting part: the AI SDK suspends
 * the loop before executing it and surfaces an approval request to the browser. Nothing moves
 * until a human answers.
 */
import { tool } from 'ai';
import { z } from 'zod';
import orders from '@/data/orders.json';

type Order = (typeof orders)[number];

/** Stands in for a database. A real app would query one here. */
const book: Order[] = orders.map((o) => ({ ...o }));

function find(orderId: string): Order | undefined {
    return book.find((o) => o.id.toLowerCase() === orderId.trim().toLowerCase());
}

export const tools = {
    search_orders: tool({
        description:
            'Find orders by customer name or status. Use this when the user has not given an ' +
            'order id. Returns ids and one-line summaries, not full records.',
        inputSchema: z.object({
            query: z.string().describe('A customer name, or a status such as "delayed" or "lost".'),
        }),
        execute: async ({ query }) => {
            const q = query.trim().toLowerCase();
            const hits = book.filter(
                (o) => o.customer.toLowerCase().includes(q) || o.status.toLowerCase().includes(q),
            );
            return {
                count: hits.length,
                orders: hits.map((o) => ({
                    id: o.id,
                    customer: o.customer,
                    status: o.status,
                    total: o.total,
                })),
            };
        },
    }),

    lookup_order: tool({
        description: 'Read one order in full, including carrier, ETA and account notes.',
        inputSchema: z.object({
            orderId: z.string().describe('The order id, for example "A-1043".'),
        }),
        execute: async ({ orderId }) => {
            const order = find(orderId);
            if (!order) {
                // Returning a value rather than throwing lets the model recover on its own -
                // usually by calling search_orders instead of stopping.
                return { found: false as const, message: `No order ${orderId} in this account.` };
            }
            return { found: true as const, order };
        },
    }),

    issue_refund: tool({
        description:
            'Refund an order in full. This moves money and cannot be undone from here.',
        inputSchema: z.object({
            orderId: z.string().describe('The order id to refund.'),
            reason: z.string().describe('A short reason, shown to the person approving.'),
        }),
        // The whole point of this sample: the loop stops here and waits for a human.
        needsApproval: true,
        execute: async ({ orderId, reason }) => {
            const order = find(orderId);
            if (!order) return { refunded: false as const, message: `No order ${orderId}.` };
            if (order.refunded) {
                return { refunded: false as const, message: `${order.id} was already refunded.` };
            }
            order.refunded = true;
            return {
                refunded: true as const,
                orderId: order.id,
                amount: order.total,
                reason,
            };
        },
    }),
};

export type AppTools = typeof tools;
