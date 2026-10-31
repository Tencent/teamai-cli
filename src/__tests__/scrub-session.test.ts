/**
 * scrub.test.ts — 迁移脱敏（--scrub）。
 */
import { describe, expect, it } from 'vitest';
import { scrubSession } from '../session-flow/scrub.js';
import type { Session } from '../session-flow/ir.js';

function makeSession(): Session {
  return {
    sessionId: 'cccc1111-dddd-4eee-8fff-000011112222',
    title: '调接口: sk-ABCDEFGH1234567890abcdefghij',
    cwd: '/tmp/proj',
    platform: 'claude-code',
    createdAt: '2026-09-21T10:00:00.000Z',
    updatedAt: '2026-09-21T10:00:06.000Z',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'token 是 sk-ABCDEFGH1234567890abcdefghij' }],
        timestamp: '2026-09-21T10:00:00.000Z',
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          {
            type: 'tool_call',
            toolName: 'bash',
            callId: 'toolu_1',
            arguments: { command: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop" https://x' },
          },
        ],
        timestamp: '2026-09-21T10:00:05.000Z',
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            callId: 'toolu_1',
            content: 'password=hunter2SecretValue db=postgres://u:pw123456@10.0.0.5:5432/app',
            isError: false,
          },
        ],
        timestamp: '2026-09-21T10:00:06.000Z',
      },
    ],
    metadata: {},
  };
}

describe('scrubSession', () => {
  it('文本 / 工具参数 / 工具结果 / 标题都被脱敏', () => {
    const result = scrubSession(makeSession());
    const dump = JSON.stringify(result.session);

    expect(dump).not.toContain('sk-ABCDEFGH1234567890abcdefghij');
    expect(dump).not.toContain('hunter2SecretValue');
    expect(dump).not.toContain('pw123456');
    expect(dump).toContain('<REDACTED:');
    expect(result.session.title).not.toContain('sk-ABCDEFGH');
    expect(result.redactedCount).toBeGreaterThan(0);
  });

  it('消息结构与条数不变（脱敏只替换值）', () => {
    const before = makeSession();
    const after = scrubSession(before).session;
    expect(after.messages).toHaveLength(before.messages.length);
    expect(after.messages[1].content.map((b) => b.type)).toEqual(
      before.messages[1].content.map((b) => b.type),
    );
    // 工具参数仍是对象，不能退化成字符串
    const call = after.messages[1].content.find((b) => b.type === 'tool_call');
    expect(call).toBeTruthy();
    expect(typeof (call as { arguments: unknown }).arguments).toBe('object');
  });

  it('图片块的本地绝对路径也被去掉（否则脱敏了正文却泄露家目录）', () => {
    const s = makeSession();
    s.messages.push({
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/png', filePath: '/Users/alice/secret/screenshot.png', label: 'shot.png' },
      ],
      timestamp: s.createdAt,
    });
    const result = scrubSession(s);
    expect(JSON.stringify(result.session)).not.toContain('/Users/alice/secret');
  });

  it('本地迁移可以保留图片路径（只有归档才必须丢弃）', () => {
    const s = makeSession();
    s.messages.push({
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', filePath: '/Users/alice/shot.png', label: 'shot.png' }],
      timestamp: s.createdAt,
    });
    const kept = scrubSession(s, { dropImagePaths: false }).session;
    const last = kept.messages[kept.messages.length - 1].content[0];
    expect(last).toMatchObject({ type: 'image', filePath: '/Users/alice/shot.png' });
  });

  it('keeps tool arguments masked when masking a number in them leaves no JSON to parse', () => {
    const session = makeSession();
    session.messages = [{
      role: 'assistant',
      content: [{ type: 'tool_call', toolName: 'db', callId: 'toolu_2', arguments: { pin: 4938, token: `ghp_${'A1b2C3d4E5F6'.repeat(3)}` } }],
      timestamp: session.createdAt,
    }];

    const { session: scrubbed } = scrubSession(session, { secrets: { WAREHOUSE_PIN: '4938' } });

    expect(scrubbed.messages[0].content[0]).toMatchObject({ type: 'tool_call', arguments: { redacted: '{"pin":<REDACTED:WAREHOUSE_PIN>,"token":"<REDACTED:gh_tok>"}' } });
  });

  it('masks a secret with a quote or backslash inside tool arguments', () => {
    const secret = 'p@ss"w0rd\\x9';
    const session = makeSession();
    session.messages[1].content[1] = {
      type: 'tool_call',
      toolName: 'bash',
      callId: 'toolu_1',
      arguments: { command: `PGPASSWORD='${secret}' psql` },
    };

    const { session: scrubbed } = scrubSession(session, { secrets: { DB_PASSWORD: secret } });

    expect(scrubbed.messages[1].content[1]).toMatchObject({
      arguments: { command: "PGPASSWORD='<REDACTED:DB_PASSWORD>' psql" },
    });
  });

  it('无敏感内容时原样返回、计数为 0', () => {
    const clean = makeSession();
    clean.title = '普通提问';
    clean.messages = [
      { role: 'user', content: [{ type: 'text', text: '帮我看下这个报错' }], timestamp: clean.createdAt },
    ];
    const result = scrubSession(clean);
    expect(result.redactedCount).toBe(0);
    expect(result.session.messages[0].content[0]).toEqual({ type: 'text', text: '帮我看下这个报错' });
  });
});

describe('scrubSession with localPaths, for a session published to the team archive', () => {
  const machine = { repo: ['/Users/alice/app'], home: ['/Users/alice'], tmp: ['/private/tmp/claude-502'] };
  const windows = { repo: ['C:\\Users\\alice\\app'], home: ['C:\\Users\\alice'], tmp: [] };
  const said = (text: string, cwd = '/Users/alice/app'): Session => ({ ...makeSession(), title: 'paths', cwd, messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
  const textOf = (session: Session): unknown => session.messages[0].content[0];

  it.each([
    ['/Users/alice/app/src/sync.ts', '<repo>/src/sync.ts'],
    ['/Users/alice/app', '<repo>'],
    ['/Users/alice/.claude/settings.json', '~/.claude/settings.json'],
    ['/Users/alice/other-project/x.ts', '~/other-project/x.ts'],
    ['/Users/alice/app2/x.ts', '~/app2/x.ts'],
    ['/private/tmp/claude-502/-Users-alice-app/6e64/tasks/b.output', '<tmp>/<project>/6e64/tasks/b.output'],
    ['file:///Users/alice/app/README.md', 'file://<repo>/README.md'],
    ['src/sync.ts, /api/v1/users, https://github.com/acme/app', 'src/sync.ts, /api/v1/users, https://github.com/acme/app'],
  ])('rewrites %s to %s', (before, after) => {
    expect(textOf(scrubSession(said(`see ${before}`), { localPaths: machine }).session)).toEqual({ type: 'text', text: `see ${after}` });
  });

  it('rewrites a Windows path under the repository', () => {
    const { session } = scrubSession(said('open C:\\Users\\alice\\app\\src\\sync.ts', 'C:\\Users\\alice\\app'), { localPaths: windows });

    expect(textOf(session)).toEqual({ type: 'text', text: 'open <repo>\\src\\sync.ts' });
  });

  it('rewrites the title, thinking, tool results and string metadata', () => {
    const session: Session = {
      ...makeSession(),
      title: 'fix /Users/alice/app/src/sync.ts',
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', text: 'read /Users/alice/app/a.ts', signature: 'sig' }], metadata: { model: 'claude-opus-5-5', cwd: '/Users/alice/app/packages/api' } },
        { role: 'user', content: [{ type: 'tool_result', callId: 't1', content: 'Output is being written to: /private/tmp/claude-502/x.output', isError: false }] },
      ],
    };

    const { session: published } = scrubSession(session, { localPaths: machine });

    expect(published.title).toBe('fix <repo>/src/sync.ts');
    expect(published.messages[0]).toMatchObject({ content: [{ type: 'thinking', text: 'read <repo>/a.ts', signature: 'sig' }], metadata: { model: 'claude-opus-5-5', cwd: '<repo>/packages/api' } });
    expect(published.messages[1].content[0]).toMatchObject({ content: 'Output is being written to: <tmp>/x.output' });
  });

  it('rewrites a path in tool call arguments that hold no secret, Windows paths included', () => {
    const session: Session = {
      ...makeSession(),
      cwd: 'C:\\Users\\alice\\app',
      messages: [{ role: 'assistant', content: [{ type: 'tool_call', toolName: 'Read', callId: 't1', arguments: { file_path: 'C:\\Users\\alice\\app\\src\\sync.ts', limit: 20, paths: ['C:\\Users\\alice\\notes.md'] } }] }],
    };

    const { session: published } = scrubSession(session, { localPaths: windows });

    expect(published.messages[0].content[0]).toMatchObject({ arguments: { file_path: '<repo>\\src\\sync.ts', limit: 20, paths: ['~\\notes.md'] } });
  });

  it('keeps local paths when no localPaths are given, as a native read for scoring needs them', () => {
    const { session } = scrubSession(said('cat /Users/alice/app/skills/review/SKILL.md'));

    expect(textOf(session)).toEqual({ type: 'text', text: 'cat /Users/alice/app/skills/review/SKILL.md' });
  });
});
