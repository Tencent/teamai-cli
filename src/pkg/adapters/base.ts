import type { Scope } from '../../types.js';
import { execCommand, type CommandExecutor } from '@teamai/shared/exec';
import type { PackageLock, PackageStatus } from '../types.js';

export interface PackageInstallContext {
  cwd: string;
  scope: Scope;
  dryRun?: boolean;
  previousPackages?: PackageLock['packages'];
}

export abstract class PackageAdapter<TDeclaration, TLockSection> {
  abstract readonly ecosystem: 'npm' | 'claude';

  protected readonly execute: CommandExecutor;

  constructor(executor: CommandExecutor = execCommand) {
    this.execute = executor;
  }

  abstract detect(cwd: string): Promise<boolean>;
  abstract install(
    declaration: TDeclaration,
    context: PackageInstallContext,
  ): Promise<TLockSection>;
  abstract status(
    declaration: TDeclaration,
    context: PackageInstallContext,
  ): Promise<PackageStatus[]>;
}
