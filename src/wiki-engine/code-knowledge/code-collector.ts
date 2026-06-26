import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { safeIgnore, toPosix } from "../core/wiki-protocol.js";

const execFileAsync = promisify(execFile);

export interface CodeCollectedFile {
  path: string;
  relativePath: string;
  language: string;
  sha256: string;
  content: string;
  isKeyFile?: boolean;
  repo?: string;
}

export const KEY_FILE_PATTERNS: Record<string, RegExp[]> = {
  go: [/main\.go$/, /cmd\/.*\.go$/, /handler.*\.go$/, /server\.go$/, /router\.go$/],
  python: [/main\.py$/, /app\.py$/, /server\.py$/, /routes?\.py$/, /models?\.py$/],
  java: [/Application\.java$/, /Controller\.java$/, /Service\.java$/],
  typescript: [/index\.ts$/, /server\.ts$/, /app\.ts$/, /router\.ts$/],
  rust: [/main\.rs$/, /lib\.rs$/, /mod\.rs$/]
};

export function isKeyFile(relativePath: string, language: string): boolean {
  const patterns = KEY_FILE_PATTERNS[language];
  if (!patterns) return false;
  return patterns.some((pattern) => pattern.test(relativePath));
}

export interface CodeCollectionManifest {
  schemaVersion: "team-wiki.code-collection.v1";
  root: string;
  commit?: string;
  collectedAt: string;
  files: Array<Omit<CodeCollectedFile, "content">>;
}

export interface CollectCodeOptions {
  root: string;
  maxFiles?: number;
  includeTests?: boolean;
  changedFiles?: string[];
}

export async function collectCode(options: CollectCodeOptions): Promise<{ manifest: CodeCollectionManifest; files: CodeCollectedFile[] }> {
  const root = path.resolve(options.root);
  const filePaths: string[] = [];
  await walk(root, filePaths, options.includeTests ?? false);

  // Sort: key files first, then by directory depth (shallow first)
  let filtered = filePaths.sort((a, b) => {
    const relA = toPosix(path.relative(root, a));
    const relB = toPosix(path.relative(root, b));
    const langA = languageFor(a);
    const langB = languageFor(b);
    const keyA = isKeyFile(relA, langA) ? 0 : 1;
    const keyB = isKeyFile(relB, langB) ? 0 : 1;
    if (keyA !== keyB) return keyA - keyB;
    const depthA = relA.split('/').length;
    const depthB = relB.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return relA.localeCompare(relB);
  });

  // Filter to only changed files if specified
  if (options.changedFiles && options.changedFiles.length > 0) {
    const changedSet = new Set(options.changedFiles.map((f) => toPosix(f)));
    filtered = filtered.filter((fp) => {
      const relativePath = toPosix(path.relative(root, fp));
      return changedSet.has(relativePath);
    });
  }

  const limited = filtered.slice(0, options.maxFiles ?? 200);
  const files: CodeCollectedFile[] = [];

  for (const filePath of limited) {
    const content = await readFile(filePath, "utf8");
    const relativePath = toPosix(path.relative(root, filePath));
    const language = languageFor(filePath);
    files.push({
      path: filePath,
      relativePath,
      language,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
      isKeyFile: isKeyFile(relativePath, language)
    });
  }

  return {
    manifest: {
      schemaVersion: "team-wiki.code-collection.v1",
      root,
      commit: await gitCommit(root),
      collectedAt: new Date().toISOString(),
      files: files.map(({ content: _content, ...file }) => file)
    },
    files
  };
}

async function walk(directory: string, results: string[], includeTests: boolean): Promise<void> {
  if (safeIgnore(directory)) {
    return;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (safeIgnore(fullPath) || (!includeTests && isTestPath(fullPath))) {
      continue;
    }
    if (entry.isDirectory()) {
      await walk(fullPath, results, includeTests);
    } else if (entry.isFile() && isCodeFile(fullPath) && (await stat(fullPath)).size < 256_000) {
      results.push(fullPath);
    }
  }
}

function isCodeFile(filePath: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".json", ".yaml", ".yml", ".toml", ".sql", ".conf", ".ini"].includes(
    path.extname(filePath).toLowerCase()
  );
}

function isTestPath(filePath: string): boolean {
  return /(^|\/|\\)(test|tests|__tests__|fixtures)(\/|\\)|\.test\.|\.spec\./u.test(filePath);
}

function languageFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml", ".sql": "sql", ".conf": "toml", ".ini": "toml",
  };
  return map[ext] ?? "text";
}

async function gitCommit(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// --- Multi-repo support ---

export interface RepoEntry {
  name: string;
  path: string;
  language?: string; // auto-detected if not provided
}

export interface MultiRepoCollectOptions {
  repos: RepoEntry[];
  maxFilesPerRepo?: number;
  includeTests?: boolean;
}

export interface MultiRepoManifest {
  schemaVersion: "team-wiki.multi-repo.v1";
  repos: Array<RepoEntry & { commit?: string; fileCount: number; primaryLanguage: string }>;
  collectedAt: string;
  totalFiles: number;
}

export async function collectMultiRepo(options: MultiRepoCollectOptions): Promise<{
  manifest: MultiRepoManifest;
  files: CodeCollectedFile[];
}> {
  const allFiles: CodeCollectedFile[] = [];
  const repoDetails: MultiRepoManifest["repos"] = [];

  for (const repo of options.repos) {
    const collection = await collectCode({
      root: repo.path,
      maxFiles: options.maxFilesPerRepo ?? 200,
      includeTests: options.includeTests ?? false
    });

    const repoFiles = collection.files.map((file) => ({ ...file, repo: repo.name }));
    allFiles.push(...repoFiles);

    const primaryLanguage = repo.language ?? detectPrimaryLanguage(repoFiles);
    repoDetails.push({
      name: repo.name,
      path: repo.path,
      language: repo.language,
      commit: collection.manifest.commit,
      fileCount: repoFiles.length,
      primaryLanguage
    });
  }

  return {
    manifest: {
      schemaVersion: "team-wiki.multi-repo.v1",
      repos: repoDetails,
      collectedAt: new Date().toISOString(),
      totalFiles: allFiles.length
    },
    files: allFiles
  };
}

function detectPrimaryLanguage(files: CodeCollectedFile[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (file.language !== "json" && file.language !== "yaml" && file.language !== "text") {
      counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return "unknown";
  let max = 0;
  let primary = "unknown";
  for (const [lang, count] of counts) {
    if (count > max) {
      max = count;
      primary = lang;
    }
  }
  return primary;
}
