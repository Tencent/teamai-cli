import type { LocalConfig } from './types.js';

/**
 * Reject write operations against a read-only HTTP team repo (issue #1, 方案一).
 *
 * HTTP consumers only pull; push / contribute / remove and member+reviewer
 * setup are not supported. Lives in its own module so command tests that fully
 * mock `./config.js` are unaffected.
 */
export function assertNotReadOnly(localConfig: LocalConfig, op: string): void {
  if (localConfig.repo.kind === 'http') {
    throw new Error(
      `This team uses a read-only HTTP source — \`${op}\` is not supported. ` +
        `Ask a team admin to update the team repo.`,
    );
  }
}
