import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { injectClaudeMdSection } from '../utils/claudemd.js';

const START = '<!-- [test:start] -->';
const END = '<!-- [test:end] -->';

function makeBlock(content: string): string {
    return [START, content, END].join('\n');
}

describe('injectClaudeMdSection', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-claudemd-'));
    });

    afterEach(async () => {
        await fse.remove(tmpDir);
    });

    it('should create file with block when file does not exist', async () => {
        const filePath = path.join(tmpDir, 'CLAUDE.md');
        const block = makeBlock('hello');

        await injectClaudeMdSection(filePath, START, END, block);

        const result = await fse.readFile(filePath, 'utf-8');
        expect(result).toContain(START);
        expect(result).toContain('hello');
        expect(result).toContain(END);
    });

    it('should replace existing section when both markers present', async () => {
        const filePath = path.join(tmpDir, 'CLAUDE.md');
        const original = `# My Doc\n\n${START}\nold content\n${END}\n\n# Footer`;
        await fse.writeFile(filePath, original);

        const block = makeBlock('new content');
        await injectClaudeMdSection(filePath, START, END, block);

        const result = await fse.readFile(filePath, 'utf-8');
        expect(result).toContain('new content');
        expect(result).not.toContain('old content');
        expect(result).toContain('# My Doc');
        expect(result).toContain('# Footer');
    });

    it('should append when neither marker is present', async () => {
        const filePath = path.join(tmpDir, 'CLAUDE.md');
        await fse.writeFile(filePath, '# Existing content');

        const block = makeBlock('appended');
        await injectClaudeMdSection(filePath, START, END, block);

        const result = await fse.readFile(filePath, 'utf-8');
        expect(result).toContain('# Existing content');
        expect(result).toContain('appended');
        expect(result).toContain(START);
    });

    it('should append when only one marker is present (corrupted)', async () => {
        const filePath = path.join(tmpDir, 'CLAUDE.md');
        await fse.writeFile(filePath, `# Doc\n\n${START}\ncorrupted`);

        const block = makeBlock('fixed');
        await injectClaudeMdSection(filePath, START, END, block);

        const result = await fse.readFile(filePath, 'utf-8');
        // Should contain both the corrupted original and the new appended block
        expect(result).toContain('fixed');
        expect(result).toContain(END);
    });
});
