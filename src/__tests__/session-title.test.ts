import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../session-flow/adapters/claude-code.js';
import { WorkBuddyAdapter } from '../session-flow/adapters/workbuddy.js';
import { scrubSession } from '../session-flow/scrub.js';
import { cleanTitleText, fallbackTitle, isInjectedText, titleFromCandidates } from '../session-flow/title.js';

describe('session title cleaning', () => {
  it('detects platform-injected message heads', () => {
    expect(isInjectedText('<system-reminder data-role="command-caveat">Caveat: ...')).toBe(true);
    expect(isInjectedText('<memories>long injected context</memories>')).toBe(true);
    expect(isInjectedText('<command-name>/teamai</command-name>')).toBe(true);
    expect(isInjectedText('怎么把会话迁移到 claude？')).toBe(false);
  });

  it('strips injected wrapper tags and keeps human text', () => {
    expect(cleanTitleText('<system-reminder>x</system-reminder> 怎么迁移会话')).toBe('怎么迁移会话');
  });

  it('truncates long titles', () => {
    expect(cleanTitleText('a'.repeat(200))).toHaveLength(60);
  });

  it('returns empty for text that cannot be fully stripped', () => {
    // 半截标签剥不干净（残留尖括号），宁可返回空让调用方退回 Session <id>
    expect(cleanTitleText('text <b unclosed')).toBe('');
    expect(cleanTitleText('')).toBe('');
  });

  it('flags an unterminated injected head even though tag-stripping would leave plain text', () => {
    // 整条是不是注入由 isInjectedText 先判断；cleanTitleText 只负责剥标签
    expect(isInjectedText('<system-reminder>unterminated caveat')).toBe(true);
  });

  it('titles a Codex session by the question after the AGENTS.md block Codex injects as its first message', () => {
    const agents = '# AGENTS.md instructions for /work/app\n\n<INSTRUCTIONS>\n# Team rules\n\nAlways write tests.\n</INSTRUCTIONS>';

    expect(isInjectedText(agents)).toBe(true);
    expect(titleFromCandidates([agents, 'Add retries to the client'])).toBe('Add retries to the client');
  });

  it('falls back to a short id-based title', () => {
    expect(fallbackTitle('1fc6ec8d-3b68-4a03-8a82-950a736eee72')).toBe('Session 1fc6ec8d');
  });
});

describe('a WorkBuddy session title', () => {
  it('keeps no start of a secret its stored title carries past the title length once scrubbed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workbuddy-title-'));
    const sessionId = '7c1e0000-0000-4000-8000-000000000031';
    const token = `ghp_${'A1b2C3d4E5F6'.repeat(3)}`;
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: `${'Deploy the staging build '.repeat(3)}now with token ${token}` })}\n`);
    try {
      const { session } = scrubSession(await new WorkBuddyAdapter().readSession({ sessionId, filePath: file }));

      expect(session.title).not.toContain(token.slice(0, 8));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps no start of a secret the team declares that its title carries past the title length once scrubbed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workbuddy-title-'));
    const sessionId = '7c1e0000-0000-4000-8000-000000000032';
    const file = path.join(dir, `${sessionId}.jsonl`);
    const start = `${'Load the warehouse '.repeat(4)}from `;
    fs.writeFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: `${start}mysql-prod-7Hq2xVb9Lk tonight` })}\n`);
    try {
      const { session } = scrubSession(await new WorkBuddyAdapter().readSession({ sessionId, filePath: file }), { secrets: { WAREHOUSE_DSN: 'mysql-prod-7Hq2xVb9Lk' } });

      expect(session.title).toBe(`${start}<REDACTED:WAREHOUSE`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a Claude Code session title', () => {
  it('keeps no start of a declared secret its title cuts inside after the same secret in full', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-claude-title-'));
    const sessionId = '7c1e0000-0000-4000-8000-000000000034';
    const file = path.join(dir, `${sessionId}.jsonl`);
    const prompt = 'Use mysql-prod-7Hq2xVb9Lk and compare with mysql-prod-7Hq2xVb9Lk';
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, cwd: dir, sessionId, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: prompt } })}\n`);
    try {
      const { session } = scrubSession(await new ClaudeCodeAdapter().readSession({ sessionId, filePath: file }), { secrets: { DSN: 'mysql-prod-7Hq2xVb9Lk' } });

      expect(session.title).toBe('Use <REDACTED:DSN> and compare with <REDACTED:DSN>');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
