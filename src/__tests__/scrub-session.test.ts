/**
 * scrub.test.ts — 迁移脱敏（--scrub）。
 */
import { describe, expect, it } from 'vitest';
import { scrubSession, titleSpellsLocalPath } from '../session-flow/scrub.js';
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
  const machine = { repo: ['/Users/me/app'], home: ['/Users/me'], tmp: ['/private/tmp/claude-502'] };
  const windows = { repo: ['C:\\Users\\me\\app'], home: ['C:\\Users\\me'], tmp: [] };
  const said = (text: string, cwd = '/Users/me/app'): Session => ({ ...makeSession(), title: 'paths', cwd, messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
  const textOf = (session: Session): unknown => session.messages[0].content[0];

  it.each([
    ['/Users/me/app/src/sync.ts', '<repo>/src/sync.ts'],
    ['/Users/me/app', '<repo>'],
    ['/Users/me/.claude/settings.json', '~/.claude/settings.json'],
    ['/Users/me/other-project/x.ts', '~/other-project/x.ts'],
    ['/Users/me/app2/x.ts', '~/app2/x.ts'],
    ['/Users/me/app.old/x.ts', '~/app.old/x.ts'],
    ['/Users/me/app@2/x.ts and /Users/me/app (copy)/x.ts', '~/app@2/x.ts and <repo> (copy)/x.ts'],
    ['("/Users/me/app/x.ts"), `/Users/me/app`: done', '("<repo>/x.ts"), `<repo>`: done'],
    ['/mnt/Users/me/app/x.ts and --cwd=/Users/me/app', '/mnt/Users/me/app/x.ts and --cwd=<repo>'],
    ['Read **/Users/me/app/x.ts**, *~/a* or [/Users/me/app]', 'Read **<repo>/x.ts**, *~/a* or [<repo>]'],
    ['Read __/Users/me/app/x.ts__ or _/Users/me/app_, not /x_/Users/me/app', 'Read __<repo>/x.ts__ or _<repo>_, not /x_/Users/me/app'],
    ['/Users/me/appé/x.ts and /Users/me/app_old/x.ts', '~/appé/x.ts and ~/app_old/x.ts'],
    ['看一下/Users/me/app/src/retry.ts', '看一下<repo>/src/retry.ts'],
    ['文件在/Users/me/app/x.ts，请看', '文件在<repo>/x.ts，请看'],
    ['~/.claude/projects/-Users-me-other-project/x.jsonl', '~/.claude/projects/~-other-project/x.jsonl'],
    ['ls /Users/me/app.', 'ls <repo>.'],
    ['/private/tmp/claude-502/-Users-me-app/6e64/tasks/b.output', '<tmp>/<project>/6e64/tasks/b.output'],
    ['file:///Users/me/app/README.md', 'file://<repo>/README.md'],
    ['src/sync.ts, /api/v1/users, https://github.com/acme/app', 'src/sync.ts, /api/v1/users, https://github.com/acme/app'],
  ])('rewrites %s to %s', (before, after) => {
    expect(textOf(scrubSession(said(`see ${before}`), { localPaths: machine }).session)).toEqual({ type: 'text', text: `see ${after}` });
  });

  it.each([
    ['Review /Users/me/app/packages/api/src/retry.ts and /Users/me/ap', 'Review <repo>/packages/api/src/retry.ts and <repo>'],
    ['Compare /Users/m', 'Compare ~'],
    ['Clean /private/tmp/claude-5', 'Clean <tmp>'],
    ['Check /Users/me', 'Check ~'],
  ])('rewrites a path the title was cut inside: %s', (title, published) => {
    expect(scrubSession({ ...said('hi'), title }, { localPaths: machine }).session.title).toBe(published);
  });

  it.each([
    ['fix C:/Users/me/app/src/retry.ts', windows, true],
    ['fix c:\\users\\me\\app\\src\\retry.ts', windows, true],
    ['fix /c/Users/me/app/src/retry.ts', windows, true],
    ['Compare /Users/m', machine, true],
    ['fix <repo>/src/retry.ts', machine, false],
    ['fix /Users/me/app/src/retry.ts', { repo: ['/Users/you/app'], home: ['/Users/you'], tmp: [] }, false],
  ])('tells whether a title spells a local path: %s', (title, roots, spells) => {
    expect(titleSpellsLocalPath(title, roots, '/Users/me/app')).toBe(spells);
  });

  it('rewrites a path under a short repository root, and never treats a filesystem root as one', () => {
    const { session } = scrubSession(said('see /ws/src/index.ts and /etc/hosts', '/ws'), { localPaths: { repo: ['/ws'], home: ['/'], tmp: ['C:\\'] } });

    expect(textOf(session)).toEqual({ type: 'text', text: 'see <repo>/src/index.ts and /etc/hosts' });
  });

  it('rewrites a Windows path under the repository', () => {
    const { session } = scrubSession(said('open C:\\Users\\me\\app\\src\\sync.ts', 'C:\\Users\\me\\app'), { localPaths: windows });

    expect(textOf(session)).toEqual({ type: 'text', text: 'open <repo>\\src\\sync.ts' });
  });

  it.each([
    ['cat /c/Users/me/app/src/retry.ts', 'cat <repo>/src/retry.ts'],
    ['ls /c/Users/me/x and /C/Users/me/app', 'ls ~/x and <repo>'],
  ])('rewrites a Windows path as Git Bash spells it: %s', (before, after) => {
    expect(textOf(scrubSession(said(before, 'C:\\Users\\me\\app'), { localPaths: windows }).session)).toEqual({ type: 'text', text: after });
  });

  it('rewrites a root with a space or an accent as a file URL percent-encodes it', () => {
    const roots = { repo: ['/Users/José/My App'], home: ['/Users/José'], tmp: [] };

    const { session } = scrubSession(said('open file:///Users/Jos%C3%A9/My%20App/README.md and file:///Users/Jos%C3%A9/notes.md', '/Users/José/My App'), { localPaths: roots });

    expect(textOf(session)).toEqual({ type: 'text', text: 'open file://<repo>/README.md and file://~/notes.md' });
  });

  it('rewrites a Windows path spelled in another case, or escaped in JSON a tool returned', () => {
    const session: Session = {
      ...said('open c:\\users\\me\\app\\src\\sync.ts', 'C:\\Users\\me\\app'),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'open c:\\users\\me\\app\\src\\sync.ts' }] },
        { role: 'user', content: [{ type: 'tool_result', callId: 't1', content: JSON.stringify({ file: 'C:\\Users\\me\\app\\src\\retry.ts' }), isError: false }] },
      ],
    };

    const { session: published } = scrubSession(session, { localPaths: windows });

    expect(published.messages[0].content[0]).toEqual({ type: 'text', text: 'open <repo>\\src\\sync.ts' });
    expect(published.messages[1].content[0]).toMatchObject({ content: JSON.stringify({ file: '<repo>\\src\\retry.ts' }) });
  });

  it('keeps a POSIX path that differs from the repository only in case, which is another directory', () => {
    const { session } = scrubSession(said('see /srv/app/src/retry.ts and /srv/App/src/retry.ts', '/srv/App'), { localPaths: { repo: ['/srv/App'], home: [], tmp: [] } });

    expect(textOf(session)).toEqual({ type: 'text', text: 'see /srv/app/src/retry.ts and <repo>/src/retry.ts' });
  });

  it('rewrites the directory the session ran in as written through a link, as where it is in the repository', () => {
    const roots = { repo: ['/srv/app'], home: [], tmp: [], workdir: { spellings: ['/opt/api'], archived: 'packages/api' } };

    const { session } = scrubSession(said('edit /opt/api/src/retry.ts', '/opt/api'), { localPaths: roots });

    expect(textOf(session)).toEqual({ type: 'text', text: 'edit <repo>/packages/api/src/retry.ts' });
  });

  it('rewrites the directory of a session that ran outside any repository as <cwd>', () => {
    const roots = { repo: [], home: ['/home/dev'], tmp: ['/tmp'], workdir: { spellings: ['/srv/scratch'], archived: '' } };

    const { session } = scrubSession(said('edit /srv/scratch/a.ts', '/srv/scratch'), { localPaths: roots });

    expect(textOf(session)).toEqual({ type: 'text', text: 'edit <cwd>/a.ts' });
  });

  it('rewrites the title, thinking, tool results and string metadata', () => {
    const session: Session = {
      ...makeSession(),
      title: 'fix /Users/me/app/src/sync.ts',
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', text: 'read /Users/me/app/a.ts', signature: 'sig' }], metadata: { model: 'claude-opus-5-5', cwd: '/Users/me/app/packages/api' } },
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
      cwd: 'C:\\Users\\me\\app',
      messages: [{ role: 'assistant', content: [{ type: 'tool_call', toolName: 'Read', callId: 't1', arguments: { file_path: 'C:\\Users\\me\\app\\src\\sync.ts', limit: 20, paths: ['C:\\Users\\me\\notes.md'] } }] }],
    };

    const { session: published } = scrubSession(session, { localPaths: windows });

    expect(published.messages[0].content[0]).toMatchObject({ arguments: { file_path: '<repo>\\src\\sync.ts', limit: 20, paths: ['~\\notes.md'] } });
  });

  it('keeps local paths when no localPaths are given, as a native read for scoring needs them', () => {
    const { session } = scrubSession(said('cat /Users/me/app/skills/review/SKILL.md'));

    expect(textOf(session)).toEqual({ type: 'text', text: 'cat /Users/me/app/skills/review/SKILL.md' });
  });
});
