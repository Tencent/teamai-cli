#!/usr/bin/env node
/**
 * Standalone local mock of the teamai HTTP backend — the three local-agent
 * interfaces (report / sync / ack), the HTTP team-repo `/repo` endpoint, and a
 * skill zip download endpoint. Use it to exercise `teamai init --http`,
 * `teamai pull`, and the hooks-driven status reporter end to end on a dev box.
 *
 * Usage:
 *   node scripts/mock-teamai-server.mjs                 # port 8787, key "dev-key"
 *   PORT=9000 API_KEY=secret node scripts/mock-teamai-server.mjs
 *
 * To drive a status-reporter install, set SEED_INSTALL=<slug> so the first
 * `sync` returns an install_skill command for that slug.
 *
 * Then point teamai at it:
 *   teamai login dev-key
 *   teamai init --http http://127.0.0.1:8787
 *   TEAMAI_REPORT_ENDPOINT=http://127.0.0.1:8787 TEAMAI_REPORT_AGENTS=codebuddy \
 *     teamai hook-dispatch session-start --tool codebuddy < /dev/null
 */

import http from 'node:http';
import { zipSync, strToU8 } from 'fflate';

const PORT = Number(process.env.PORT ?? 8787);
const API_KEY = process.env.API_KEY ?? 'dev-key';
const SEED_INSTALL = process.env.SEED_INSTALL ?? '';

let pendingCommands = SEED_INSTALL
  ? [
      {
        id: 1,
        type: 'install_skill',
        skill_slug: SEED_INSTALL,
        skill_version: '1.0.0',
        download_url: `http://127.0.0.1:${PORT}/download?slug=${SEED_INSTALL}&access_token=smh`,
      },
    ]
  : [];

function buildSkillZip(slug) {
  return zipSync({
    [`${slug}/SKILL.md`]: strToU8(`---\nname: ${slug}\nversion: 1.0.0\ndescription: mock skill\n---\nbody`),
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && url.pathname === '/download') {
    const slug = url.searchParams.get('slug') ?? 'skill';
    res.writeHead(200, { 'Content-Type': 'application/zip' });
    res.end(Buffer.from(buildSkillZip(slug)));
    return;
  }

  if ((req.headers.authorization ?? '') !== `Bearer ${API_KEY}`) {
    json(401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/repo') {
    json(200, {
      version: 'v1',
      files: [
        { path: 'teamai.yaml', content: 'team: mock\nrepo: http://mock\nsharing: {}\n' },
        { path: 'rules/common/demo.md', content: '# demo rule\n' },
      ],
      commands: [
        {
          type: 'install_skill',
          skill_slug: 'weather',
          skill_version: '1.0.0',
          download_url: `http://127.0.0.1:${PORT}/download?slug=weather&access_token=smh`,
        },
      ],
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/local-agent/report') {
    const body = await readBody(req);
    console.log('[report]', JSON.stringify(body));
    json(200, { ok: true, instance_id: 'local-mock-abc123' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/local-agent/sync') {
    const body = await readBody(req);
    console.log('[sync]', JSON.stringify(body));
    const commands = pendingCommands;
    pendingCommands = [];
    json(200, { ok: true, commands });
    return;
  }

  // ack: the command id now travels in the request body (id: int).
  if (req.method === 'POST' && url.pathname === '/api/local-agent/commands/ack') {
    const body = await readBody(req);
    console.log(`[ack ${body.id}]`, JSON.stringify(body));
    json(200, { ok: true });
    return;
  }

  json(404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock teamai server on http://127.0.0.1:${PORT} (API_KEY=${API_KEY})`);
  if (SEED_INSTALL) console.log(`seeded sync install_skill: ${SEED_INSTALL}`);
});
