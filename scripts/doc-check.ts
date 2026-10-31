/** Run a documentation check, retaining its name in the command's diagnostic. */
export async function check(name: string, run: () => void | Promise<void>, cleanup?: () => void): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(`Documentation check failed: ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    cleanup?.();
  }
}
