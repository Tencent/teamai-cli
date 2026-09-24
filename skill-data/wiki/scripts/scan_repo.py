#!/usr/bin/env python3
"""
scan_repo.py: repository structure scan and statistics tool

Purpose: in the Phase 0 source material collection stage, quickly scan the target repository/directory and print:
  1. Directory tree (2 levels deep)
  2. Code statistics (language distribution, file count, total lines)
  3. Key file discovery (entry files, config files, Proto/IDL, error code definitions)
  4. Code hotspots (top 20 files by line count)

Usage:
  python3 scan_repo.py /path/to/repo
  python3 scan_repo.py /path/to/repo --depth 3 --top 30
"""

import os
import sys
import argparse
from pathlib import Path
from collections import defaultdict, Counter

# Key file match patterns
KEY_FILE_PATTERNS = {
    "Entry files": [
        "main.py", "main.go", "app.py", "app.ts", "app.js",
        "server.py", "server.go", "wsgi.py", "manage.py",
        "cmd/*/main.go", "index.ts", "index.js",
    ],
    "Routes/Handlers": [
        "*handler*", "*router*", "*controller*", "*dispatch*",
        "*route*", "*api.*", "*endpoint*",
    ],
    "Config files": [
        "*.yaml", "*.yml", "*.toml", "*.ini", "*.conf",
        "*config*", "*.env", "*.env.*",
    ],
    "Proto/IDL": [
        "*.proto", "*.thrift", "*.graphql", "*schema*",
    ],
    "Database/Models": [
        "*model*", "*dao*", "*repository*", "*migration*",
        "*schema*", "*.sql", "*db*",
    ],
    "Constants/Error codes": [
        "*const*", "*constant*", "*error*", "*code*",
        "*enum*", "*define*", "*exception*",
    ],
    "Test files": [
        "*_test.*", "test_*", "*.spec.*", "*_spec.*",
    ],
}

# Language extension map
LANG_MAP = {
    ".py": "Python", ".go": "Go", ".js": "JavaScript", ".ts": "TypeScript",
    ".java": "Java", ".rs": "Rust", ".rb": "Ruby", ".php": "PHP",
    ".c": "C", ".cpp": "C++", ".h": "C/C++ Header",
    ".proto": "Protobuf", ".thrift": "Thrift", ".graphql": "GraphQL",
    ".sql": "SQL", ".sh": "Shell", ".bash": "Shell",
    ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
    ".json": "JSON", ".xml": "XML", ".md": "Markdown",
}

# Ignored directories
IGNORE_DIRS = {
    ".git", ".svn", "node_modules", "__pycache__", ".tox", ".mypy_cache",
    "venv", ".venv", "env", ".env", "vendor", "dist", "build",
    ".idea", ".vscode", ".eggs", "*.egg-info",
}


def should_ignore(path: Path) -> bool:
    for part in path.parts:
        if part in IGNORE_DIRS or part.endswith(".egg-info"):
            return True
    return False


def count_lines(filepath: Path) -> int:
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            return sum(1 for _ in f)
    except (OSError, UnicodeDecodeError):
        return 0


def match_pattern(filename: str, pattern: str) -> bool:
    """Simple wildcard match"""
    import fnmatch
    return fnmatch.fnmatch(filename.lower(), pattern.lower())


def scan_repository(repo_path: Path, depth: int = 2, top_n: int = 20):
    """Scan the repository and return the statistics"""

    all_files = []
    lang_stats = Counter()       # language -> (file count, line count)
    lang_lines = Counter()
    key_files = defaultdict(list)
    dir_tree = []

    # Walk the files
    for root, dirs, files in os.walk(repo_path):
        rel_root = Path(root).relative_to(repo_path)

        # Skip ignored directories
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.endswith(".egg-info")]

        # Directory tree (depth-limited)
        level = len(rel_root.parts)
        if level <= depth:
            indent = "  " * level
            dirname = rel_root.parts[-1] if rel_root.parts else str(repo_path.name)
            dir_tree.append(f"{indent}├── {dirname}/")

        for fname in files:
            fpath = Path(root) / fname
            if should_ignore(fpath.relative_to(repo_path)):
                continue

            ext = fpath.suffix.lower()
            lines = count_lines(fpath)
            rel_path = str(fpath.relative_to(repo_path))

            all_files.append((rel_path, ext, lines))

            # Language statistics
            lang = LANG_MAP.get(ext)
            if lang:
                lang_stats[lang] += 1
                lang_lines[lang] += lines

            # Key file matching
            for category, patterns in KEY_FILE_PATTERNS.items():
                for pattern in patterns:
                    if match_pattern(fname, pattern):
                        key_files[category].append((rel_path, lines))
                        break

    return all_files, lang_stats, lang_lines, key_files, dir_tree


def print_report(repo_path: Path, all_files, lang_stats, lang_lines, key_files, dir_tree, top_n: int):
    """Print the scan report"""

    total_files = len(all_files)
    total_lines = sum(f[2] for f in all_files)

    print("=" * 70)
    print(f"  Repository scan report: {repo_path.name}")
    print(f"  Path: {repo_path}")
    print("=" * 70)

    # 1. Basic statistics
    print(f"\n## 1. Basic statistics\n")
    print(f"| Metric | Value |")
    print(f"|------|------|")
    print(f"| Total files | {total_files} |")
    print(f"| Total lines of code | {total_lines:,} |")
    print(f"| Languages | {len(lang_stats)} |")

    # 2. Language distribution
    print(f"\n## 2. Language distribution\n")
    print(f"| Language | Files | Lines | Share |")
    print(f"|------|--------|---------|------|")
    for lang, count in lang_stats.most_common(15):
        lines = lang_lines[lang]
        pct = f"{lines / total_lines * 100:.1f}%" if total_lines > 0 else "0%"
        print(f"| {lang} | {count} | {lines:,} | {pct} |")

    # 3. Directory structure
    print(f"\n## 3. Directory structure (first 30 lines)\n")
    print("```")
    for line in dir_tree[:30]:
        print(line)
    if len(dir_tree) > 30:
        print(f"  ... ({len(dir_tree) - 30} more directories)")
    print("```")

    # 4. Key file discovery
    print(f"\n## 4. Key file discovery\n")
    for category, files in key_files.items():
        if files:
            print(f"\n### {category} ({len(files)} files)\n")
            # Deduplicate and sort
            seen = set()
            for fpath, lines in sorted(files, key=lambda x: -x[1])[:10]:
                if fpath not in seen:
                    seen.add(fpath)
                    print(f"- `{fpath}` ({lines:,} lines)")

    # 5. Code hotspots
    print(f"\n## 5. Code hotspots (Top {top_n})\n")
    print(f"| Rank | File | Lines |")
    print(f"|------|------|------|")
    sorted_files = sorted(all_files, key=lambda x: -x[2])
    for i, (fpath, ext, lines) in enumerate(sorted_files[:top_n], 1):
        print(f"| {i} | `{fpath}` | {lines:,} |")

    print(f"\n{'=' * 70}")
    print(f"  Scan complete. {total_files} files, {total_lines:,} lines of code.")
    print(f"{'=' * 70}")


def main():
    parser = argparse.ArgumentParser(description="Repository structure scan and statistics tool")
    parser.add_argument("repo_path", help="Path of the repository/directory to scan")
    parser.add_argument("--depth", type=int, default=2, help="Directory tree depth (default 2)")
    parser.add_argument("--top", type=int, default=20, help="Code hotspots top N (default 20)")
    args = parser.parse_args()

    repo_path = Path(args.repo_path).resolve()
    if not repo_path.is_dir():
        print(f"Error: {repo_path} is not a valid directory", file=sys.stderr)
        sys.exit(1)

    all_files, lang_stats, lang_lines, key_files, dir_tree = scan_repository(
        repo_path, depth=args.depth, top_n=args.top
    )
    print_report(repo_path, all_files, lang_stats, lang_lines, key_files, dir_tree, args.top)


if __name__ == "__main__":
    main()
