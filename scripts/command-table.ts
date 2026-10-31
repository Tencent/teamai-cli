/** The real CLI command table, loaded without executing command actions. */
export async function loadCommandTable() {
  const previous = process.env.TEAMAI_COMMAND_TABLE_ONLY;
  process.env.TEAMAI_COMMAND_TABLE_ONLY = '1';
  try {
    const { program } = await import('../src/index.js');
    return program;
  } finally {
    if (previous === undefined) delete process.env.TEAMAI_COMMAND_TABLE_ONLY;
    else process.env.TEAMAI_COMMAND_TABLE_ONLY = previous;
  }
}
