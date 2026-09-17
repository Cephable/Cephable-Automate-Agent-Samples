/**
 * Mint a gateway API key and print the config entry for it.
 *
 * The key is shown once, here, and only its hash goes in the config file — so losing it means minting
 * a new one, and a leaked config file is not a set of working credentials.
 *
 *   npm run keygen -- --label "partner demo" --id partner-demo --allow-inline-mcp
 */

import { generateKey, hashKey } from './auth.ts';

function flag(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const value = process.argv[index + 1];
    return value && !value.startsWith('--') ? value : '';
}

const label = flag('label') || 'unnamed client';
const id = flag('id') || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client';
const allowInlineMcp = process.argv.includes('--allow-inline-mcp');
const maxTimeoutMs = Number(flag('max-timeout-ms') || 120_000);

const key = generateKey();

console.log('\nAPI key (shown once — copy it now):\n');
console.log(`  ${key}\n`);
console.log('Add this to the "keys" array in gateway.config.json:\n');
console.log(
    JSON.stringify({ id, label, sha256: hashKey(key), allowInlineMcp, maxTimeoutMs }, null, 4)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
);
console.log('\nThe config stores only the hash. Revoke by deleting the entry and restarting.\n');
