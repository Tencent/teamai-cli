/**
 * In-process mock of the teamai HTTP backend (the three local-agent interfaces
 * report/sync/ack, the routes a session start reads (`get-config`,
 * `projects/mine`, `plugins/config`), skill zip and rule file downloads).
 *
 * Used by the e2e tests and mirrors `scripts/mock-teamai-server.mjs` (the
 * standalone runnable server the reviewer asked for). Bearer auth is enforced
 * so the read-only-consumer / reporter auth paths are exercised.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { zipSync, strToU8 } from 'fflate';
import type { SkillCommand } from '../../skill-command.js';

/**
 * A command the sync hands back: any type the local agent runs, with the
 * `scope` (`user` | `workspace`) and `workspace_path` every type may carry.
 */
export type MockCommand = (SkillCommand | { id?: number; type: string; [field: string]: unknown }) & {
  scope?: string;
  workspace_path?: string;
};

export interface MockServerConfig {
  apiKey: string;
  /** Commands handed back by the next sync call, then cleared. */
  pendingCommands?: MockCommand[];
  /** Slug → file map used to synthesize downloadable skill zips. */
  skillFiles?: Record<string, Record<string, string>>;
  /** Slug → the `name:` its SKILL.md declares, when it is not the slug. */
  skillNames?: Record<string, string>;
  /** Slug → the markdown `/download?kind=rule&slug=<slug>` serves (default: a heading naming the slug). */
  ruleFiles?: Record<string, string>;
}

export interface MockServerHandle {
  url: string;
  close: () => Promise<void>;
  reports: unknown[];
  syncs: unknown[];
  acks: Array<{ id: number; body: unknown }>;
  /** Queue commands the next sync should return (download_url can use `url`). */
  seedCommands: (cmds: MockCommand[]) => void;
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
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization ?? '';

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // Skill zip or rule file download — SMH-style: no Bearer header, token in query.
    if (req.method === 'GET' && url.pathname === '/download') {
      const slug = url.searchParams.get('slug') ?? '';
      if (url.searchParams.get('kind') === 'rule') {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end(config.ruleFiles?.[slug] ?? `# ${slug}\n\nRule ${slug} from the backend.\n`);
        return;
      }
      const zip = buildSkillZip(slug, config.skillFiles?.[slug], { name: config.skillNames?.[slug] });
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(Buffer.from(zip));
      return;
    }

    // Everything else requires Bearer auth.
    if (auth !== `Bearer ${config.apiKey}`) {
      json(401, { error: 'unauthorized' });
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

    // Read by a session start: plugin config (default and overridden route) and the member's projects.
    if (req.method === 'GET' && (url.pathname === '/api/local-agent/get-config' || url.pathname === '/api/plugins/config')) {
      json(200, {});
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/projects/mine') {
      json(200, { ok: true, projects: [] });
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
