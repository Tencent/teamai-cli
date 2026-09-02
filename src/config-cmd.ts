/**
 * `teamai config` command family — list / get / set / ui.
 *
 * list/get/set share the config service (readConfigBundle /
 * applyConfigPatch) with the Config WebUI, so CLI and UI validation are
 * identical by construction. All CLI output is English.
 */
import type { Scope } from './types.js';
import { log } from './utils/logger.js';
import { detectProjectConfig } from './config.js';
import { findFieldSpec, CONFIG_FIELDS } from './config-fields.js';
import {
  readConfigBundle,
  applyConfigPatch,
  normalizeFieldValue,
  NotInitializedError,
} from './config-service.js';

/** Resolve the active scope: explicit flag > project config in cwd > user. */
export async function resolveConfigScope(explicit?: string): Promise<{ scope: Scope; projectRoot?: string }> {
  if (explicit === 'user' || explicit === 'project') {
    return explicit === 'project'
      ? { scope: 'project', projectRoot: process.cwd() }
      : { scope: 'user' };
  }
  const project = await detectProjectConfig();
  return project ? { scope: 'project', projectRoot: process.cwd() } : { scope: 'user' };
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '(unset)';
  if (Array.isArray(value)) return value.length > 0 ? JSON.stringify(value) : '(unset)';
  if (typeof value === 'boolean') return String(value);
  return String(value);
}

export async function configList(scopeFlag?: string): Promise<void> {
  const { scope, projectRoot } = await resolveConfigScope(scopeFlag);
  let bundle;
  try {
    bundle = await readConfigBundle(scope, projectRoot);
  } catch (e) {
    if (e instanceof NotInitializedError) {
      log.error(e.message);
      process.exit(1);
      return;
    }
    throw e;
  }

  log.info(`Config for ${scope} scope${projectRoot ? ` (${projectRoot})` : ''}:\n`);
  const keyWidth = Math.max(...CONFIG_FIELDS.map((f) => f.key.length));
  const valWidth = 30;
  const srcWidth = 12;
  const grpWidth = 6;
  const header =
    `${'KEY'.padEnd(keyWidth)}  ${'VALUE'.padEnd(valWidth)}  ${'SOURCE'.padEnd(srcWidth)}  ${'GROUP'.padEnd(grpWidth)}  DESCRIPTION`;
  log.info(header);
  log.info('-'.repeat(header.length));
  for (const field of bundle.fields) {
    const value = formatValue(field.value).slice(0, valWidth - 1) + (formatValue(field.value).length >= valWidth ? '…' : '');
    log.info(
      `${field.spec.key.padEnd(keyWidth)}  ${value.padEnd(valWidth)}  ${field.source.padEnd(srcWidth)}  ${field.spec.group.padEnd(grpWidth)}  ${field.spec.readOnly ? '[read-only] ' : ''}${field.spec.description}`,
    );
  }
  log.dim(`\nEditable fields: ${CONFIG_FIELDS.filter((f) => !f.readOnly && f.scopes.length > 0).length}. Use \`teamai config set <key> <value>\`.`);
}

export async function configGet(field: string, scopeFlag?: string): Promise<void> {
  const spec = findFieldSpec(field);
  if (!spec) {
    log.error(`Unknown config field "${field}". Run \`teamai config list\` for valid keys.`);
    process.exit(1);
    return;
  }

  const { scope, projectRoot } = await resolveConfigScope(scopeFlag);
  let bundle;
  try {
    bundle = await readConfigBundle(scope, projectRoot);
  } catch (e) {
    if (e instanceof NotInitializedError) {
      log.error(e.message);
      process.exit(1);
      return;
    }
    throw e;
  }

  const resolved = bundle.fields.find((f) => f.spec.key === spec.key)!;
  log.info(`${spec.key} = ${formatValue(resolved.value)}`);
  if (resolved.source === 'team-default') {
    log.dim('(team default; set explicitly to override)');
  } else if (resolved.source === 'user' && scope === 'project') {
    log.dim('(inherited from user scope; not set in this project)');
  }
}

export async function configSet(field: string, value: string, scopeFlag?: string): Promise<void> {
  const spec = findFieldSpec(field);
  if (!spec) {
    log.error(`Unknown config field "${field}". Run \`teamai config list\` for valid keys.`);
    process.exit(1);
    return;
  }
  if (spec.readOnly) {
    log.error(
      `${spec.label} is read-only${spec.readOnlyHint ? ` (managed by \`${spec.readOnlyHint}\`)` : ''}.`,
    );
    process.exit(1);
    return;
  }

  const { scope, projectRoot } = await resolveConfigScope(scopeFlag);
  if (!spec.scopes.includes(scope)) {
    log.error(`${spec.label} is not editable in ${scope} scope.`);
    process.exit(1);
    return;
  }

  // Early parse for a friendlier message than the generic pipeline error.
  try {
    normalizeFieldValue(spec, value);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
    return;
  }

  let result;
  try {
    result = await applyConfigPatch(scope, { [field]: value }, projectRoot);
  } catch (e) {
    if (e instanceof NotInitializedError) {
      log.error(e.message);
      process.exit(1);
      return;
    }
    throw e;
  }

  if (!result.ok) {
    for (const err of result.errors) {
      log.error(`${err.key}: ${err.message}`);
    }
    process.exit(1);
    return;
  }

  log.success(`Set ${field} = ${formatValue(deepValue(result.config, field))}`);
  for (const err of result.errors) {
    log.warn(`${err.key}: ${err.message}`);
  }
  if (field === 'primaryRole' || field === 'additionalRoles' || field === 'excludedSkills' || field === 'repo.branch') {
    log.dim('Run `teamai pull` to apply the change to local AI tools.');
  }
}

function deepValue(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export async function configUi(port?: number, scopeFlag?: string): Promise<void> {
  const { startConfigUi } = await import('./config-ui.js');
  await startConfigUi(port, scopeFlag);
}
