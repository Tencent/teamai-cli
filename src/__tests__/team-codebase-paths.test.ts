// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';

import { getTeamCodebasePaths, safeDomainSlug, TEAM_CODEBASE_DIR } from '../utils/team-codebase-paths.js';

describe('getTeamCodebasePaths', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-paths-test-'));
    });

    afterEach(async () => {
        await fs.remove(tmpDir);
    });

    it('默认路径：root = <cwd>/docs/team-codebase', () => {
        const paths = getTeamCodebasePaths(tmpDir);
        expect(paths.root).toBe(path.join(tmpDir, 'docs', TEAM_CODEBASE_DIR));
        expect(paths.index).toBe(path.join(tmpDir, 'docs', TEAM_CODEBASE_DIR, 'index.md'));
        expect(paths.domainsDir).toBe(path.join(tmpDir, 'docs', TEAM_CODEBASE_DIR, 'domains'));
        expect(paths.reposDir).toBe(path.join(tmpDir, 'docs', TEAM_CODEBASE_DIR, 'repos'));
    });

    it('output 覆盖时 root 直接使用 output', () => {
        const customOutput = path.join(tmpDir, 'custom-output');
        const paths = getTeamCodebasePaths(tmpDir, customOutput);
        expect(paths.root).toBe(customOutput);
        expect(paths.index).toBe(path.join(customOutput, 'index.md'));
        expect(paths.domainsDir).toBe(path.join(customOutput, 'domains'));
        expect(paths.reposDir).toBe(path.join(customOutput, 'repos'));
    });

    it('TEAM_CODEBASE_DIR 常量值为 team-codebase', () => {
        expect(TEAM_CODEBASE_DIR).toBe('team-codebase');
    });
});

describe('safeDomainSlug', () => {
    it('普通中文域名直接保留', () => {
        expect(safeDomainSlug('推理')).toBe('推理');
    });

    it('含 / 的域名替换为 _', () => {
        expect(safeDomainSlug('推理/训练')).toBe('推理_训练');
    });

    it('含 \\ 的域名替换为 _', () => {
        expect(safeDomainSlug('推理\\训练')).toBe('推理_训练');
    });

    it('含 : 的域名替换为 _', () => {
        expect(safeDomainSlug('推理:训练')).toBe('推理_训练');
    });

    it('空字符串 → unnamed', () => {
        expect(safeDomainSlug('')).toBe('unnamed');
    });

    it('纯空白 → unnamed', () => {
        expect(safeDomainSlug('   ')).toBe('unnamed');
    });

    it('带前后空白 → trim 后的结果', () => {
        expect(safeDomainSlug('  推理  ')).toBe('推理');
    });

    it('普通英文域名不变', () => {
        expect(safeDomainSlug('inference')).toBe('inference');
    });

    it('混合特殊字符全部替换', () => {
        expect(safeDomainSlug('a/b\\c:d')).toBe('a_b_c_d');
    });
});
