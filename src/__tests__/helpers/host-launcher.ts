import { hostProcess, stepLauncher, type StepLauncher, type ToolResolve, type ToolSpawn } from '@teamai/runtime-tools';
import { toolsLaunchDeps } from '../../workflow/runtimes/sources.js';

/** The `tools` runtime's launcher on this machine, spawning with `spawnTool` and finding executables with the resolvers given. */
export function hostLauncher(spawnTool?: ToolSpawn, resolveTool?: ToolResolve, resolveInstanceCommand?: ToolResolve): StepLauncher {
  return stepLauncher(toolsLaunchDeps(), { start: hostProcess(spawnTool), ...(resolveTool && { resolveTool }), ...(resolveInstanceCommand && { resolveInstanceCommand }) });
}
