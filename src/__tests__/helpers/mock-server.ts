/**
 * In-process mock of the teamai HTTP backend (the three local-agent interfaces
 * report/sync/ack + the HTTP team-repo /repo endpoint + skill zip download).
 *
 * Used by the e2e tests and mirrors `scripts/mock-teamai-server.mjs` (the
 * standalone runnable server the reviewer asked for). Bearer auth is enforced
 * so the read-only-consumer / reporter auth paths are exercised.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { zipSync, strToU8 } from 'fflate';
import type { SkillCommand } from '../../skill-command.js';
import type { RepoFile } from '../../source-http.js';

export interface MockServerConfig {
  apiKey: string;
  /** /repo response. */
  repo?: { version: string | null; files: RepoFile[]; commands: SkillCommand[] };
  /** Commands handed back by the next sync call, then cleared. */
  pendingCommands?: SkillCommand[];
  /** Slug → file map used to synthesize downloadable skill zips. */
  skillFiles?: Record<string, Record<string, string>>;
}

export interface MockServerHandle {
  url: string;
  close: () => Promise<void>;
  reports: unknown[];
  syncs: unknown[];
  acks: Array<{ id: number; body: unknown }>;
  /** Queue commands the next sync should return (download_url can use `url`). */
  seedCommands: (cmds: SkillCommand[]) => void;
  /** Set the /repo response after start (download_url can use `url`). */
  seedRepo: (repo: NonNullable<MockServerConfig['repo']>) => void;
}

/** Build a valid skill zip (`<slug>/SKILL.md` + extra files). */
export function buildSkillZip(
  slug: string,
  files: Record<string, string> = {},
  opts: { name?: string } = {},
): Uint8Array {
  const skillName = opts.name ?? slug;
  const entries: Record<string, Uint8Array> = {
    [`${slug}/SKILL.md`]: strToU8(`---\nname: ${skillName}\nversion: 1.0.0\ndescription: mock\n---\nbody`),
  };
  for (const [rel, content] of Object.entries(files)) {
    entries[`${slug}/${rel}`] = strToU8(content);
  }
  return zipSync(entries);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

export async function startMockServer(config: MockServerConfig): Promise<MockServerHandle> {
  const handle: MockServerHandle = {
    url: '',
    close: async () => {},
    reports: [],
    syncs: [],
    acks: [],
    seedCommands: (cmds) => {
      config.pendingCommands = cmds;
    },
    seedRepo: (repo) => {
      config.repo = repo;
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization ?? '';

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // Skill zip download — SMH-style: no Bearer header, token in query.
    if (req.method === 'GET' && url.pathname === '/download') {
      const slug = url.searchParams.get('slug') ?? '';
      const zip = buildSkillZip(slug, config.skillFiles?.[slug]);
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(Buffer.from(zip));
      return;
    }

    // Everything else requires Bearer auth.
    if (auth !== `Bearer ${config.apiKey}`) {
      json(401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/repo') {
      json(200, config.repo ?? { version: 'v1', files: [], commands: [] });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/local-agent/report') {
      handle.reports.push(await readBody(req));
      json(200, { ok: true, instance_id: 'local-mock-abc123' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/local-agent/sync') {
      handle.syncs.push(await readBody(req));
      const commands = config.pendingCommands ?? [];
      config.pendingCommands = []; // deliver once
      json(200, { ok: true, commands });
      return;
    }

    // ack: the command id now travels in the request body (id: int).
    if (req.method === 'POST' && url.pathname === '/api/local-agent/commands/ack') {
      const body = (await readBody(req)) as { id?: number };
      handle.acks.push({ id: body.id as number, body });
      json(200, { ok: true });
      return;
    }

    json(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  handle.url = `http://127.0.0.1:${port}`;
  handle.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return handle;
}
