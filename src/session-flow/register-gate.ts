/** Whether this process should register `teamai session` migration subcommands. */
export function shouldRegisterSessionFlowCommands(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.TEAMAI_COMMAND_TABLE_ONLY) return true;
  return argv.includes('session');
}
