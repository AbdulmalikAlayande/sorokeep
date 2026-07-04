import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('get_monitored_keys_spec.md', () => {
    const specPath = path.resolve(__dirname, '../../docs/get_monitored_keys_spec.md');

    it('should exist', () => {
        expect(fs.existsSync(specPath)).toBe(true);
    });

    it('should define the standard get_monitored_keys() signature', () => {
        const content = fs.readFileSync(specPath, 'utf8');
        expect(content).toContain('get_monitored_keys');
        expect(content).toContain('Vec<ScVal>');
    });

    it('should include valid Rust Soroban contract code snippets', () => {
        const content = fs.readFileSync(specPath, 'utf8');
        expect(content).toMatch(/```rust/);
        expect(content).toContain('#[contractimpl]');
        expect(content).toContain('pub fn get_monitored_keys');
    });

    it('should cover ERC/SEP metadata conventions or similar motivations', () => {
        const content = fs.readFileSync(specPath, 'utf8');
        expect(content.toLowerCase()).toContain('sep');
    });
});
