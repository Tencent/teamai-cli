import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    parseFrontmatter,
    splitFrontmatter,
    stripFrontmatter,
    hasFrontmatter,
    stringifyFrontmatter,
} from '../utils/frontmatter.js';
import { log } from '../utils/logger.js';

const BOM = '﻿';

describe('parseFrontmatter', () => {
    const variants = [
        { label: 'LF',       content: '---\nname: foo\ndescription: bar\n---\nbody' },
        { label: 'CRLF',     content: '---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody' },
        { label: 'BOM+LF',   content: BOM + '---\nname: foo\ndescription: bar\n---\nbody' },
        { label: 'BOM+CRLF', content: BOM + '---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody' },
    ];

    for (const { label, content } of variants) {
        it(`parses data and body correctly (${label})`, () => {
            const { data, body } = parseFrontmatter(content);
            expect(data.name).toBe('foo');
            expect(data.description).toBe('bar');
            expect(body).toBe('body');
        });
    }

    it('returns empty data and original body when no frontmatter', () => {
        const { data, body } = parseFrontmatter('# just body');
        expect(data).toEqual({});
        expect(body).toBe('# just body');
    });

    it('strips BOM from plain body when no frontmatter', () => {
        const { data, body } = parseFrontmatter(BOM + '# just body');
        expect(data).toEqual({});
        expect(body).toBe('# just body');
    });
});

describe('parseFrontmatter – malformed YAML', () => {
    it('does not throw and returns empty data', () => {
        expect(() => parseFrontmatter('---\n: : :\n---\nx')).not.toThrow();
        const { data } = parseFrontmatter('---\n: : :\n---\nx');
        expect(data).toEqual({});
    });

    it('remains invalid when the same malformed block is parsed repeatedly', () => {
        const input = '---\nname: original\ncustom: [\n---\nbody';
        expect(splitFrontmatter(input).valid).toBe(false);
        expect(splitFrontmatter(input).valid).toBe(false);
    });
});

describe('splitFrontmatter – round-trip', () => {
    it('raw + body equals BOM-stripped input for LF', () => {
        const input = '---\nname: foo\n---\nbody';
        const { raw, body } = splitFrontmatter(input);
        expect(raw + body).toBe(input);
    });

    it('raw + body equals BOM-stripped input for CRLF', () => {
        const input = '---\r\nname: foo\r\n---\r\nbody';
        const { raw, body } = splitFrontmatter(input);
        expect(raw + body).toBe(input);
    });

    it('raw + body equals BOM-stripped input when BOM+LF', () => {
        const input = BOM + '---\nname: foo\n---\nbody';
        const { raw, body } = splitFrontmatter(input);
        expect(raw + body).toBe(input.slice(1)); // BOM stripped
    });

    it('raw is empty string when no frontmatter', () => {
        const { raw } = splitFrontmatter('# plain body');
        expect(raw).toBe('');
    });
});

describe('splitFrontmatter – empty frontmatter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        { label: 'LF', prefix: '', eol: '\n' },
        { label: 'CRLF', prefix: '', eol: '\r\n' },
        { label: 'BOM+LF', prefix: BOM, eol: '\n' },
        { label: 'BOM+CRLF', prefix: BOM, eol: '\r\n' },
    ])('keeps body separators outside the frontmatter ($label)', ({ prefix, eol }) => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        const raw = `---${eol}---${eol}`;
        const body = ['# Guardrails', 'Never delete user data.', '', '---', '# Style', 'Use English output.'].join(eol);
        const input = prefix + raw + body;

        expect(splitFrontmatter(input)).toEqual({ data: {}, valid: true, raw, body });
        expect(stripFrontmatter(input)).toBe(body);
        expect(hasFrontmatter(prefix + raw)).toBe(true);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each(['---\n---', '---\r\n---', '--- \n---\t'])('accepts an empty block at EOF: %j', (input) => {
        expect(splitFrontmatter(input)).toEqual({ data: {}, valid: true, raw: input, body: '' });
        expect(hasFrontmatter(input)).toBe(true);
    });

    it.each(['\n', '\r\n'])('accepts whitespace on delimiter lines with a BOM and %j line endings', (eol) => {
        const raw = `--- \t${eol}---\t ${eol}`;
        const body = `# Rule${eol}Never commit secrets.${eol}---${eol}`;
        expect(splitFrontmatter(BOM + raw + body)).toEqual({ data: {}, valid: true, raw, body });
    });
});

describe('splitFrontmatter – delimiter boundaries', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each(['\n', '\r\n'])('does not treat a partial fence as a closing delimiter with %j line endings', (eol) => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        const input = ['---', '---not-a-fence', '# Body', ''].join(eol);

        expect(splitFrontmatter(input)).toEqual({ data: {}, valid: false, raw: '', body: input });
        expect(hasFrontmatter(input)).toBe(false);
        expect(warnSpy).toHaveBeenCalledOnce();
    });
});

describe('splitFrontmatter – root shape', () => {
    it('marks scalar frontmatter as invalid without exposing it as a record', () => {
        const result = splitFrontmatter('---\njust-a-scalar\n---\nbody');
        expect(result.valid).toBe(false);
        expect(result.data).toEqual({});
    });

    it('marks mapping frontmatter as valid', () => {
        expect(splitFrontmatter('---\nname: foo\n---\nbody').valid).toBe(true);
    });

    it('marks sequence and timestamp roots as invalid', () => {
        expect(splitFrontmatter('---\n- item\n---\nbody').valid).toBe(false);
        expect(splitFrontmatter('---\n2020-01-01\n---\nbody').valid).toBe(false);
    });

    it('does not share parsed data between identical blocks', () => {
        const input = '---\ntrigger: shared\n---\nbody';
        const first = splitFrontmatter(input);
        first.data.name = 'mutated';
        expect(splitFrontmatter(input).data).toEqual({ trigger: 'shared' });
    });
});

describe('parseFrontmatter – no trailing newline after closing delimiter', () => {
    it('parses frontmatter at end of string with no trailing newline', () => {
        const { data, body } = parseFrontmatter('---\nname: x\n---');
        expect(data.name).toBe('x');
        expect(body).toBe('');
    });
});

describe('stripFrontmatter', () => {
    it('returns body only for LF input', () => {
        expect(stripFrontmatter('---\nname: foo\n---\nbody')).toBe('body');
    });

    it('returns body only for CRLF input', () => {
        expect(stripFrontmatter('---\r\nname: foo\r\n---\r\nbody')).toBe('body');
    });

    it('returns original string when no frontmatter', () => {
        expect(stripFrontmatter('# plain')).toBe('# plain');
    });
});

describe('hasFrontmatter', () => {
    it('returns true for LF frontmatter', () => {
        expect(hasFrontmatter('---\nname: foo\n---\nbody')).toBe(true);
    });

    it('returns true for CRLF frontmatter', () => {
        expect(hasFrontmatter('---\r\nname: foo\r\n---\r\nbody')).toBe(true);
    });

    it('returns true for BOM-prefixed frontmatter', () => {
        expect(hasFrontmatter(BOM + '---\nname: foo\n---\nbody')).toBe(true);
    });

    it('returns false for plain body', () => {
        expect(hasFrontmatter('# just body')).toBe(false);
    });
});

describe('stringifyFrontmatter', () => {
    it('round-trips data through parseFrontmatter', () => {
        const out = stringifyFrontmatter({ name: 'a', description: 'b' }, 'body');
        const { data, body } = parseFrontmatter(out);
        expect(data.name).toBe('a');
        expect(data.description).toBe('b');
        expect(body.trim()).toBe('body');
    });

    it('produces LF-only output (no CR)', () => {
        const out = stringifyFrontmatter({ name: 'a', description: 'b' }, 'body');
        expect(out.includes('\r')).toBe(false);
    });
});

describe('splitFrontmatter – unclosed frontmatter warning', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('warns when opening --- exists but closing --- is missing', () => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        const result = splitFrontmatter('---\nname: broken\n');
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0][0]).toMatch(/no closing delimiter/);
        expect(result.data).toEqual({});
        expect(result.valid).toBe(false);
    });

    it('warns for BOM-prefixed unclosed frontmatter', () => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        splitFrontmatter(BOM + '---\nname: broken\n');
        expect(warnSpy).toHaveBeenCalledOnce();
    });

    it('warns for CRLF unclosed frontmatter', () => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        splitFrontmatter('---\r\nname: broken\r\n');
        expect(warnSpy).toHaveBeenCalledOnce();
    });

    it('does not warn when no frontmatter at all', () => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        splitFrontmatter('# just body');
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn for valid closed frontmatter', () => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        splitFrontmatter('---\nname: foo\n---\nbody');
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns for --- on its own with no content after', () => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        splitFrontmatter('---\n');
        expect(warnSpy).toHaveBeenCalledOnce();
    });
});
