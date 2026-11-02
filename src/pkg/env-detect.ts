import { probeBinary, type CommandExecutor } from '../utils/exec.js';

export interface EnvironmentVersion {
  name: 'Node' | 'npm' | 'Claude Code';
  version: string;
  available: boolean;
}

function normalizeVersion(raw: string): string {
  const match = raw.match(/v?(\d+(?:\.\d+)+)/);

  return match?.[1] ?? raw.split('\n')[0]?.trim() ?? '';
}

export async function detectPackageEnvironment(
  executor?: CommandExecutor,
): Promise<EnvironmentVersion[]> {
  const [node, npm, claude] = await Promise.all([
    probeBinary('node', ['--version'], executor),
    probeBinary('npm', ['--version'], executor),
    probeBinary('claude', ['--version'], executor),
  ]);

  return [
    { name: 'Node', version: normalizeVersion(node), available: !!node },
    { name: 'npm', version: normalizeVersion(npm), available: !!npm },
    { name: 'Claude Code', version: normalizeVersion(claude), available: !!claude },
  ];
}
