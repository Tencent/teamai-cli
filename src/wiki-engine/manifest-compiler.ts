import { readFile } from 'node:fs/promises';
import type {
  CodebaseOutputManifest,
  CodebaseOutputManifestV2,
  ManifestComponentV2,
  ManifestEdgeV2,
} from './manifest-schema.js';
import { isManifestV2 } from './manifest-schema.js';

export interface CompiledComponent {
  slug: string;
  title: string;
  category: string;
  body: string;
  upstream: string[];
  downstream: string[];
}

export interface CompiledManifest {
  project: string;
  components: CompiledComponent[];
  edges: Array<{ from: string; to: string; relation: string; reason?: string }>;
}

// Called by team-wiki-codebase skill's kb-doc-generator agent via `teamai codebase --compile`
export async function compileFromManifest(manifestPath: string): Promise<CompiledManifest> {
  const raw = await readFile(manifestPath, 'utf-8');
  const manifest: CodebaseOutputManifest = JSON.parse(raw);
  const project = manifest.project;
  const v2 = isManifestV2(manifest);

  const components: CompiledComponent[] = manifest.components.map(comp => {
    let body = `# ${comp.title ?? comp.slug}\n\n`;
    body += `**Category**: ${comp.category}\n`;
    body += `**Confidence**: ${comp.confidence}\n\n`;

    if (comp.upstream && comp.upstream.length > 0) {
      body += `**Upstream**: ${comp.upstream.join(', ')}\n`;
    }
    if (comp.downstream && comp.downstream.length > 0) {
      body += `**Downstream**: ${comp.downstream.join(', ')}\n`;
    }
    if (comp.interfaces && comp.interfaces.length > 0) {
      body += `**Interfaces**: ${comp.interfaces.join(', ')}\n`;
    }
    body += '\n';

    if (v2) {
      const v2comp = comp as ManifestComponentV2;
      if (v2comp.entrypoints && v2comp.entrypoints.length > 0) {
        body += '## Entry Points\n\n';
        for (const ep of v2comp.entrypoints) {
          body += `- \`${ep}\`\n`;
        }
        body += '\n';
      }
      if (v2comp.responsibilities && v2comp.responsibilities.length > 0) {
        body += '## Responsibilities\n\n';
        for (const resp of v2comp.responsibilities) {
          body += `- ${resp}\n`;
        }
        body += '\n';
      }
    }

    return {
      slug: comp.slug,
      title: comp.title ?? comp.slug,
      category: comp.category,
      body,
      upstream: comp.upstream ?? [],
      downstream: comp.downstream ?? [],
    };
  });

  const edges = manifest.edges.map(e => ({
    from: e.from,
    to: e.to,
    relation: e.relation,
    reason: v2 ? (e as ManifestEdgeV2).reason : undefined,
  }));

  return { project, components, edges };
}
