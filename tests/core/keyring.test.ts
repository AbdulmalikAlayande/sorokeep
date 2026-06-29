import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvResolver, KeychainResolver, FileResolver, KeyChain } from '../../src/core/keyring.js';
import { Keypair } from '@stellar/stellar-sdk';
import fs from 'fs/promises';

describe('Key Resolution Chain', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('Keys resolve correctly from process.env when configured', async () => {
        const secret = Keypair.random().secret();
        vi.stubEnv('MY_SECRET_KEY', secret);

        const resolver = new EnvResolver('MY_SECRET_KEY');
        const resolved = await resolver.resolve();
        
        expect(resolved).toBe(secret);
    });

    it('Validates signature capabilities of resolved keys', async () => {
        const kp = Keypair.random();
        const secret = kp.secret();
        vi.stubEnv('SIGNING_KEY', secret);
        
        const chain = new KeyChain();
        chain.addResolver(new EnvResolver('SIGNING_KEY'));
        
        const key = await chain.resolve();
        expect(key).toBeDefined();
        
        // validate signature capability
        const resolvedKp = Keypair.fromSecret(key!);
        const data = Buffer.from('test data');
        const signature = resolvedKp.sign(data);
        expect(resolvedKp.verify(data, signature)).toBe(true);
    });

    it('Falls back gracefully to the next provider in sequence', async () => {
        const secret = Keypair.random().secret();
        
        vi.stubEnv('MISSING_KEY', '');
        vi.stubEnv('FALLBACK_KEY', secret);
        
        const chain = new KeyChain();
        chain.addResolver(new EnvResolver('MISSING_KEY'));
        chain.addResolver(new EnvResolver('FALLBACK_KEY'));
        
        const resolvedKey = await chain.resolve();
        
        expect(resolvedKey).toBe(secret);
    });

    it('Skips invalid keys and tries the next provider', async () => {
        const secret = Keypair.random().secret();
        
        vi.stubEnv('INVALID_KEY', 'not-a-stellar-secret');
        vi.stubEnv('VALID_KEY', secret);
        
        const chain = new KeyChain();
        chain.addResolver(new EnvResolver('INVALID_KEY'));
        chain.addResolver(new EnvResolver('VALID_KEY'));
        
        const resolvedKey = await chain.resolve();
        
        expect(resolvedKey).toBe(secret);
    });
});
