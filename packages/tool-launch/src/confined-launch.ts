import { opencodeModelArgs, type ConfinedLaunch } from '@teamai/tool-core/launch';
import type { JsonValue } from '@teamai/shared/json';

/** The variables every confined run keeps from the member's environment, proxies included, beside those its profile reads. */
const COMMON_ENV = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];

// Claude reads the prompt as a system prompt file, so its user turn only asks for the reply.
const REQUEST = 'Answer from the files in this directory alone. Return only the requested JSON answer.\n';

/** The features a confined Codex run turns off. */
const CODEX_DISABLED = ['hooks', 'plugins', 'apps', 'browser_use', 'computer_use', 'multi_agent', 'multi_agent_v2'];

/** The variables a confined run on `profile` gets from the member's environment: the common ones, and those the profile reads. */
export function confinedVariables(profile: ConfinedLaunch): readonly string[] {
  return [...COMMON_ENV, ...profile.env];
}

/** The model and effort a confined run passes. */
type ConfinedModel = { readonly model?: { readonly name: string; readonly effort?: string } | undefined };

/** The JSON Schema the reply must follow, which a tool that takes one inline enforces. */
type InlineSchema = { readonly schema?: JsonValue | undefined };

/**
 * What a family's confined argv names, by the launch adapter the tool runs with, once the run has set up the files
 * the argv points at.
 */
export type ConfinedArgsInput =
  /** `settingsFile`: the settings the run keeps; `promptFile`: the prompt, which Claude reads as a system prompt. */
  | ConfinedModel & InlineSchema & { readonly family: 'claude'; readonly settingsFile: string; readonly promptFile: string }
  /** `schemaFile`: the schema written to a file, when the run has one; `answerFile`: where Codex writes its last message; `configArgs`: the member's provider settings. */
  | ConfinedModel & { readonly family: 'codex'; readonly schemaFile?: string | undefined; readonly answerFile: string; readonly configArgs: readonly string[] }
  | ConfinedModel & InlineSchema & { readonly family: 'codebuddy' }
  | ConfinedModel & { readonly family: 'cursor' | 'pi' | 'agy' }
  /** `opencodeMajor`: the OpenCode major version on PATH, which decides how an effort is passed. */
  | ConfinedModel & { readonly family: 'opencode'; readonly opencodeMajor: number };

/** The argv that runs a tool confined to its directory, read-only where its tool allows. */
export function confinedArgs(input: ConfinedArgsInput): string[] {
  const model = input.model ? ['--model', input.model.name] : [];

  switch (input.family) {
    case 'claude':
      return ['-p', '--restricted', '--tools=Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', ...jsonSchemaArgs(input), '--append-system-prompt-file', input.promptFile, '--settings', input.settingsFile, ...model, ...(input.model?.effort ? ['--effort', input.model.effort] : [])];
    case 'codex':
      return ['-a', 'never', 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', ...(input.schemaFile === undefined ? [] : ['--output-schema', input.schemaFile]), ...CODEX_DISABLED.flatMap((feature) => ['--disable', feature]), '-o', input.answerFile, ...input.configArgs, ...model, ...(input.model?.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.model.effort)}`] : []), '-'];
    case 'codebuddy':
      return ['-p', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--permission-mode', 'dontAsk', '--settings', JSON.stringify({ permissions: { allow: ['Read(./**)'] } }), '--output-format', 'json', ...jsonSchemaArgs(input), ...model];
    case 'cursor':
      return ['-p', '--output-format', 'json', '--mode', 'ask', '--sandbox', 'enabled', '--trust', ...model];
    case 'pi':
      return ['-p', '--mode', 'json', '--tools', 'read,grep,find,ls', '--no-context-files', '--no-extensions', '--no-skills', '--no-session', ...model];
    case 'agy':
      return ['--input-format=stream-json', '--output-format=stream-json', '--print=', '--mode', 'plan', '--sandbox', ...model];
    case 'opencode':
      return ['run', '--standalone', '--format', 'json', ...opencodeModelArgs(input.model, input.opencodeMajor)];
    default: {
      const unhandled: never = input;

      return unhandled;
    }
  }
}

function jsonSchemaArgs({ schema }: InlineSchema): string[] {
  return schema === undefined ? [] : ['--json-schema', JSON.stringify(schema)];
}

/** What a confined run's tool reads on stdin: only the request when the prompt goes in a file, else the request and the prompt. */
export function confinedStdin(family: ConfinedArgsInput['family'], prompt: string): string {
  return family === 'claude' ? REQUEST : REQUEST + prompt;
}
