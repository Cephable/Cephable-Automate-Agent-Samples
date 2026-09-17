/**
 * Entry point. Reads config, resolves the local Cephable server, and listens.
 *
 * Binds 127.0.0.1 by default *on purpose*. Putting this straight onto 0.0.0.0 with no TLS in front of
 * it is the mistake this whole sample exists to prevent — see the README's deployment section. Set
 * GATEWAY_HOST=0.0.0.0 only when something else is terminating TLS for you.
 */

import { loadConfig } from './auth.ts';
import { buildApp } from './app.ts';
import { CephableUpstream } from './upstream.ts';

const CONFIG_PATH = process.env.GATEWAY_CONFIG ?? './gateway.config.json';
const HOST = process.env.GATEWAY_HOST ?? '127.0.0.1';
const PORT = Number(process.env.GATEWAY_PORT ?? 8787);

async function main(): Promise<number> {
    const cephableKey = process.env.CEPHABLE_AUTOMATE_KEY;
    if (!cephableKey) {
        console.error(
            'CEPHABLE_AUTOMATE_KEY is not set.\n' +
                'Copy it from Cephable: Extensions > Cephable features > Build & Extend > Automate HTTP Server.'
        );
        return 2;
    }

    let config;
    try {
        config = loadConfig(CONFIG_PATH);
    } catch (error) {
        console.error(`Could not load ${CONFIG_PATH}: ${(error as Error).message}`);
        console.error('Create one with:  npm run keygen -- --label "my client"');
        return 2;
    }

    const upstream = new CephableUpstream({
        endpoint: process.env.CEPHABLE_ENDPOINT,
        token: cephableKey,
        maxQueueDepth: Number(process.env.GATEWAY_MAX_QUEUE ?? 4),
        maxQueueWaitMs: Number(process.env.GATEWAY_MAX_QUEUE_WAIT_MS ?? 60_000),
    });

    // Fail at startup rather than on the first request, so a misconfiguration is obvious now.
    try {
        const endpoint = await upstream.resolveEndpoint();
        const health = await upstream.health();
        console.log(`Cephable found at ${endpoint}`);
        console.log(`  app ${health.appVersion} · model ${health.modelName} · status ${health.workflowStatus}`);
    } catch (error) {
        console.error(`Could not reach Cephable: ${(error as Error).message}`);
        return 1;
    }

    const app = await buildApp({
        config,
        upstream,
        rateLimitPerMinute: Number(process.env.GATEWAY_RATE_LIMIT ?? 20),
        logger: true,
    });

    await app.listen({ host: HOST, port: PORT });

    console.log(`\nGateway listening on http://${HOST}:${PORT}`);
    console.log(`  ${config.keys.length} API key(s) configured: ${config.keys.map((k) => k.id).join(', ')}`);
    if (HOST === '0.0.0.0') {
        console.warn(
            '\n  WARNING: bound to 0.0.0.0. Make sure something in front of this is terminating TLS.\n' +
                '  Without it, every API key crosses the network in plaintext.'
        );
    }

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            console.log(`\n${signal} — closing`);
            void app.close().then(() => process.exit(0));
        });
    }

    return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
