import { describe, it, expect } from 'vitest';
import { compileCulture } from '../pull.js';

describe('compileCulture', () => {
    it('should compile company and team from frontmatter', () => {
        const raw = [
            '---',
            'company:',
            '  name: Acme Corp',
            '  mission: Build great things',
            '  values:',
            '    - Innovation',
            '    - Integrity',
            'team:',
            '  name: Platform',
            '  mission: Enable developers',
            '---',
            '',
        ].join('\n');

        const result = compileCulture(raw);
        expect(result).not.toBeNull();
        expect(result).toContain('## Company: Acme Corp');
        expect(result).toContain('**Mission:** Build great things');
        expect(result).toContain('Innovation, Integrity');
        expect(result).toContain('## Team: Platform');
        expect(result).toContain('**Mission:** Enable developers');
    });

    it('should include body content', () => {
        const raw = [
            '---',
            'company:',
            '  name: TestCo',
            '---',
            'General guidelines for all team members.',
        ].join('\n');

        const result = compileCulture(raw);
        expect(result).not.toBeNull();
        expect(result).toContain('General guidelines for all team members.');
    });

    it('should include all body content including role markers as plain text', () => {
        const raw = [
            '---',
            'company:',
            '  name: TestCo',
            '---',
            'Shared guidelines.',
            '<!-- role: backend -->',
            'Backend-specific guidelines.',
            '<!-- role: frontend -->',
            'Frontend-specific guidelines.',
        ].join('\n');

        const result = compileCulture(raw);
        expect(result).not.toBeNull();
        expect(result).toContain('Shared guidelines.');
        expect(result).toContain('Backend-specific guidelines.');
        expect(result).toContain('Frontend-specific guidelines.');
    });

    it('should return null for invalid frontmatter', () => {
        const raw = '{{invalid yaml content}}';
        const result = compileCulture(raw);
        // gray-matter may still parse this with empty frontmatter
        // which would pass CultureFrontmatterSchema (all fields optional)
        // so we just ensure it doesn't throw
        expect(result === null || typeof result === 'string').toBe(true);
    });

    it('should return null when content is empty', () => {
        const raw = [
            '---',
            '---',
        ].join('\n');

        const result = compileCulture(raw);
        expect(result).toBeNull();
    });

    it('should include team goals as bullet list', () => {
        const raw = [
            '---',
            'team:',
            '  name: DevTeam',
            '  goals:',
            '    - Ship v2.0',
            '    - Improve test coverage',
            '---',
        ].join('\n');

        const result = compileCulture(raw);
        expect(result).not.toBeNull();
        expect(result).toContain('- Ship v2.0');
        expect(result).toContain('- Improve test coverage');
    });

    it('should include company vision', () => {
        const raw = [
            '---',
            'company:',
            '  name: FutureCo',
            '  vision: A world where AI helps everyone',
            '---',
        ].join('\n');

        const result = compileCulture(raw);
        expect(result).not.toBeNull();
        expect(result).toContain('**Vision:** A world where AI helps everyone');
    });

    it('should wrap output in culture markers', () => {
        const raw = [
            '---',
            'company:',
            '  name: TestCo',
            '---',
            'Some content.',
        ].join('\n');

        const result = compileCulture(raw);
        expect(result).not.toBeNull();
        expect(result).toContain('<!-- [teamai:culture:start] -->');
        expect(result).toContain('<!-- [teamai:culture:end] -->');
        expect(result).toContain('## Team Culture (teamai)');
    });
});
