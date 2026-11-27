// -*- coding: utf-8 -*-
import { describe, it, expect } from 'vitest';
import { parseIntOption } from '../cli-int.js';

describe('parseIntOption', () => {
    it('accepts in-range integers', () => {
        expect(parseIntOption('--port', '3721', 0, 65535)).toBe(3721);
        expect(parseIntOption('--port', '0', 0, 65535)).toBe(0);
        expect(parseIntOption('--project-id', '42', 1)).toBe(42);
        expect(parseIntOption('--max-modules', '0', 0)).toBe(0);
        expect(parseIntOption('--max-modules', '1', 0)).toBe(1);
        expect(parseIntOption('--max-modules', String(Number.MAX_SAFE_INTEGER), 0)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it.each(['abc', '', '1.5', '-3', '70000', '1e3', '0x10'])('rejects --port %j instead of returning NaN', (value) => {
        expect(() => parseIntOption('--port', value, 0, 65535)).toThrow('--port must be an integer between 0 and 65535');
    });

    it.each(['abc', '', String(Number.MAX_SAFE_INTEGER + 1)])('rejects an invalid --project-id %j', (value) => {
        expect(() => parseIntOption('--project-id', value, 1)).toThrow('--project-id must be an integer >= 1');
    });
});
