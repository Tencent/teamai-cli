import type { LocalConfig } from './types.js';

/** Refuse writes through a legacy HTTP source. No HTTP delivery client remains. */
export function assertNotReadOnly(localConfig: LocalConfig, op: string): void {
  if (localConfig.repo.kind === 'http') {
    throw new Error(
      `This team uses a read-only HTTP source — \`${op}\` is not supported. ` +
        `HTTP delivery has been removed. Initialize a Git team repository.`,
    );
  }
}
