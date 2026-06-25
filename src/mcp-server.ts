import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'teamai',
    version: '1.0.0',
  });

  server.tool(
    'teamai_recall',
    'Search team knowledge base (learnings, skills, docs, rules, codebase graph). Returns ranked results with BM25 + graph-boost scoring.',
    { query: z.string().describe('Search keywords'), depth: z.enum(['route', 'context', 'lookup']).optional().describe('Result depth level') },
    async ({ query, depth }) => {
      const { recall } = await import('./recall.js');
      const output = await captureStdout(() => recall(query, { depth: depth ?? 'context' }));
      return { content: [{ type: 'text', text: output || 'No matching knowledge found.' }] };
    },
  );

  server.tool(
    'teamai_pull',
    'Pull latest team resources (skills, rules, docs, learnings) from the team repo.',
    {},
    async () => {
      const { pull } = await import('./pull.js');
      await pull({ silent: true });
      return { content: [{ type: 'text', text: 'Team resources pulled successfully.' }] };
    },
  );

  server.tool(
    'teamai_status',
    'Show diff between local resources and the team repo.',
    {},
    async () => {
      const output = await captureStdout(async () => {
        const { status } = await import('./status.js');
        await status({});
      });
      return { content: [{ type: 'text', text: output || 'Everything up to date.' }] };
    },
  );

  server.tool(
    'teamai_contribute',
    'Contribute a learning document to the team knowledge base.',
    {
      title: z.string().describe('Title of the learning'),
      content: z.string().describe('Markdown content of the learning'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
    },
    async ({ title, content, tags }) => {
      const { contributeFromMcp } = await import('./contribute-mcp.js');
      const result = await contributeFromMcp({ title, content, tags });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  server.tool(
    'teamai_import_repo',
    'Import a remote repository into the team knowledge graph (teamwiki/). Extracts code facts, builds graph, and pushes to team repo.',
    {
      url: z.string().describe('Repository URL (HTTPS or SSH)'),
      incremental: z.boolean().optional().describe('Only re-extract changed files'),
    },
    async ({ url, incremental }) => {
      try {
        const { importFromRepo } = await import('./import-repo.js');
        await importFromRepo({ url, incremental: incremental ?? false });
        return { content: [{ type: 'text', text: `Repository ${url} imported successfully. Knowledge graph updated.` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Import failed: ${(e as Error).message}` }] };
      }
    },
  );

  server.tool(
    'teamai_list',
    'List team knowledge resources.',
    { type: z.enum(['skills', 'rules', 'docs', 'learnings']).optional().describe('Resource type to list (default: all)') },
    async ({ type }) => {
      const output = await captureStdout(async () => {
        const { list } = await import('./status.js');
        await list(type ?? undefined, {});
      });
      return { content: [{ type: 'text', text: output || 'No resources found.' }] };
    },
  );

  server.tool(
    'teamai_codebase_lint',
    'Run knowledge graph health check (node connectivity, stale manifest, orphan detection).',
    {},
    async () => {
      const output = await captureStdout(async () => {
        const { codebaseCmd } = await import('./codebase-cmd.js');
        await codebaseCmd({ lint: true });
      });
      return { content: [{ type: 'text', text: output || 'Lint completed with no issues.' }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}
