import type { ToolFamilyFacts } from '@teamai/tool-core/family';
import type { SessionPlatformFacts } from '@teamai/tool-core/sessions/platform';
import { detect } from './detect.js';
import { tools } from './definitions.js';

/** A Claude build's platform: Claude Code transcripts in the home of its own `command`, which resumes them. */
function claudeBuild<const Command extends string>(command: Command) {
  return {
    store: { in: 'tool-home', home: command, dir: 'projects' },
    resume: (id: string) => `${command} --resume ${id}`,
    thinking: true, images: true,
    nativeTools: new Set([
      'read_file', 'write_file', 'edit_file', 'multi_edit', 'bash', 'glob', 'grep',
      'web_search', 'web_fetch', 'task', 'todo_write', 'notebook_edit', 'lsp',
    ]),
    legacyIdWithoutWorkspace: true,
    sqliteRegistrationOnWindows: false,
    idFormat: 'uuid',
    instanceSessions: true,
  } as const satisfies SessionPlatformFacts<Command>;
}

/** Each Claude build keeps Claude Code transcripts in its own home, so its sessions stay its own. */
const platformFacts = {
  'claude-code': claudeBuild('claude'),
  'claude-internal': claudeBuild('claude-internal'),
  'tclaude': claudeBuild('tclaude'),
} as const satisfies Record<string, SessionPlatformFacts>;

/** What every command may load of this family: its tools, its session platforms' facts and its version detectors. */
export const facts = { tools, platforms: platformFacts, detect } as const satisfies ToolFamilyFacts;
