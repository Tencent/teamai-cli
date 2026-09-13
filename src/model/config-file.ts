import crypto from 'node:crypto';
import path from 'node:path';
import fse from 'fs-extra';
import JSON5 from 'json5';
import YAML from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

export type ConfigFormat = 'json' | 'json5' | 'yaml' | 'toml';

/** Parse a config document in the given format. */
export function parseConfig(format: ConfigFormat, text: string): unknown {
  switch (format) {
    case 'json':
      return JSON.parse(text);
    case 'json5':
      return JSON5.parse(text);
    case 'yaml':
      return YAML.parse(text);
    case 'toml':
      return parseToml(text);
  }
}

/** Serialize a config document in the given format (trailing newline included). */
export function stringifyConfig(format: ConfigFormat, value: unknown): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify(value, null, 2)}\n`;
    case 'json5':
      // Parse tolerantly (comments / trailing commas) but always emit strict
      // JSON: it is valid JSON5 *and* valid JSON-with-comments, so both OpenClaw
      // and Qoder accept it. A `.bak` copy preserves the original comments.
      return `${JSON.stringify(value, null, 2)}\n`;
    case 'yaml':
      return YAML.stringify(value);
    case 'toml':
      return `${stringifyToml(value)}\n`;
  }
}

/**
 * A serialized config file on disk.
 *
 * Reads tolerate a missing or empty file (returns `{}`). Writes are atomic
 * (temp file + rename) and keep a `.bak` copy of the previous contents. A
 * symlinked target is written through to its real path so the link survives;
 * new files are created `0600` (configs may carry a resolved API key).
 */
export class ConfigFile {
  constructor(
    readonly filePath: string,
    readonly format: ConfigFormat,
  ) {}

  read(): unknown {
    if (!fse.existsSync(this.filePath)) return {};
    const raw = fse.readFileSync(this.filePath, 'utf-8');
    // Strip a UTF-8 BOM: Windows editors/PowerShell commonly add one, and every
    // parser here (JSON.parse, smol-toml) rejects it as invalid input.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    if (!text.trim()) return {};
    try {
      return parseConfig(this.format, text);
    } catch (error) {
      throw new Error(`Cannot parse ${this.filePath}: ${(error as Error).message}`);
    }
  }

  async write(value: unknown): Promise<string> {
    const text = stringifyConfig(this.format, value);
    await fse.ensureDir(path.dirname(this.filePath));

    if (fse.existsSync(this.filePath)) {
      await fse.copy(this.filePath, `${this.filePath}.bak`);
    }

    const target = await this.#resolveTarget();
    let mode = 0o600;
    try {
      mode = (await fse.stat(target)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fse.writeFile(tmp, text, 'utf-8');
      await fse.chmod(tmp, mode);
      await fse.rename(tmp, target);
    } catch (error) {
      await fse.remove(tmp).catch(() => undefined);
      throw error;
    }
    return text;
  }

  /** Follow a symlinked config file to its real path; return the path unchanged otherwise. */
  async #resolveTarget(): Promise<string> {
    try {
      if ((await fse.lstat(this.filePath)).isSymbolicLink()) {
        return await fse.realpath(this.filePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this.filePath;
  }
}
