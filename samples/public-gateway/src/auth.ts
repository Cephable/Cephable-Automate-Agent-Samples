/**
 * Gateway authentication — the gateway's own keys, entirely separate from Cephable's.
 *
 * The single most important rule in this sample: **the Cephable access key never leaves this process.**
 * Remote callers authenticate with keys the gateway issues, which the gateway can revoke one at a time.
 * Handing out the Cephable key instead would mean every caller could talk to the machine directly, with
 * no policy in front of it, and revoking one caller would mean rotating for all of them.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Caller } from './policy.ts';

/** A key as stored: only its SHA-256, so the config file is not itself a set of credentials. */
interface StoredKey extends Caller {
    sha256: string;
}

export interface GatewayConfig {
    keys: StoredKey[];
}

/** `cgw_` + 32 random bytes, base64url. Prefixed so it is recognisable in a log or a leak scan. */
export function generateKey(): string {
    return `cgw_${randomBytes(32).toString('base64url')}`;
}

export function hashKey(key: string): string {
    return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function loadConfig(path: string): GatewayConfig {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { keys?: unknown };
    if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
        throw new Error(`${path} must contain a non-empty "keys" array. Run: npm run keygen`);
    }

    return {
        keys: parsed.keys.map((entry, index) => {
            const key = entry as Record<string, unknown>;
            for (const field of ['id', 'label', 'sha256'] as const) {
                if (typeof key[field] !== 'string' || !key[field]) {
                    throw new Error(`${path}: keys[${index}].${field} is required`);
                }
            }
            if (!/^[0-9a-f]{64}$/.test(key.sha256 as string)) {
                throw new Error(
                    `${path}: keys[${index}].sha256 must be a SHA-256 hex digest. ` +
                        'Store the hash, never the key itself.'
                );
            }
            return {
                id: key.id as string,
                label: key.label as string,
                sha256: key.sha256 as string,
                allowInlineMcp: key.allowInlineMcp === true,
                maxTimeoutMs: typeof key.maxTimeoutMs === 'number' ? key.maxTimeoutMs : 120_000,
            };
        }),
    };
}

/**
 * Resolve a presented key to a caller, or null.
 *
 * Constant-time across every configured key: we hash the candidate once and compare against all of
 * them without short-circuiting, so response timing does not reveal how many keys exist or how close a
 * guess was. Cheap to do, and the alternative is a real (if slow) oracle.
 */
export function authenticate(config: GatewayConfig, presented: string | undefined): Caller | null {
    if (!presented) return null;

    const candidate = Buffer.from(hashKey(presented), 'hex');
    let matched: Caller | null = null;
    for (const key of config.keys) {
        const stored = Buffer.from(key.sha256, 'hex');
        if (candidate.length === stored.length && timingSafeEqual(candidate, stored)) {
            matched = key;
        }
    }
    return matched;
}

/** Pull the bearer token out of an Authorization header. */
export function bearerFrom(header: string | undefined): string | undefined {
    if (!header?.startsWith('Bearer ')) return undefined;
    const token = header.slice('Bearer '.length).trim();
    return token || undefined;
}
