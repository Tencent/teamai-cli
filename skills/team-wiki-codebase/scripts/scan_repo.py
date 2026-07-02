#!/usr/bin/env python3
"""
scan_repo.py — 代码仓库结构扫描与统计工具

用途: Phase 0 源材料采集阶段，快速扫描目标仓库/目录，输出：
  1. 目录结构树（2层深度）
  2. 代码统计（语言分布、文件数、总行数）
  3. 关键文件发现（入口文件、配置文件、Proto/IDL、错误码定义）
  4. 代码热点（文件行数 Top 20）

使用方式:
  python3 scan_repo.py /path/to/repo
  python3 scan_repo.py /path/to/repo --depth 3 --top 30
"""

import os
import sys
import argparse
from pathlib import Path
from collections import defaultdict, Counter

# 关键文件匹配模式
KEY_FILE_PATTERNS = {
    "入口文件": [
        "main.py", "main.go", "app.py", "app.ts", "app.js",
        "server.py", "server.go", "wsgi.py", "manage.py",
        "cmd/*/main.go", "index.ts", "index.js",
    ],
    "路由/Handler": [
        "*handler*", "*router*", "*controller*", "*dispatch*",
        "*route*", "*api.*", "*endpoint*",
    ],
    "配置文件": [
        "*.yaml", "*.yml", "*.toml", "*.ini", "*.conf",
        "*config*", "*.env", "*.env.*",
    ],
    "Proto/IDL": [
        "*.proto", "*.thrift", "*.graphql", "*schema*",
    ],
    "数据库/模型": [
        "*model*", "*dao*", "*repository*", "*migration*",
        "*schema*", "*.sql", "*db*",
    ],
    "常量/错误码": [
        "*const*", "*constant*", "*error*", "*code*",
        "*enum*", "*define*", "*exception*",
    ],
    "测试文件": [
        "*_test.*", "test_*", "*.spec.*", "*_spec.*",
    ],
}

# 语言扩展名映射
LANG_MAP = {
    ".py": "Python", ".go": "Go", ".js": "JavaScript", ".ts": "TypeScript",
    ".java": "Java", ".rs": "Rust", ".rb": "Ruby", ".php": "PHP",
    ".c": "C", ".cpp": "C++", ".h": "C/C++ Header",
    ".proto": "Protobuf", ".thrift": "Thrift", ".graphql": "GraphQL",
    ".sql": "SQL", ".sh": "Shell", ".bash": "Shell",
    ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
    ".json": "JSON", ".xml": "XML", ".md": "Markdown",
}

# 忽略目录
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
    """简单的通配符匹配"""
    import fnmatch
    return fnmatch.fnmatch(filename.lower(), pattern.lower())


def scan_repository(repo_path: Path, depth: int = 2, top_n: int = 20):
    """扫描仓库，返回统计结果"""

    all_files = []
    lang_stats = Counter()       # 语言 -> (文件数, 行数)
    lang_lines = Counter()
    key_files = defaultdict(list)
    dir_tree = []

    # 遍历文件
    for root, dirs, files in os.walk(repo_path):
        rel_root = Path(root).relative_to(repo_path)

        # 忽略目录
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.endswith(".egg-info")]

        # 目录树（限制深度）
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

            # 语言统计
            lang = LANG_MAP.get(ext)
            if lang:
                lang_stats[lang] += 1
                lang_lines[lang] += lines

            # 关键文件匹配
            for category, patterns in KEY_FILE_PATTERNS.items():
                for pattern in patterns:
                    if match_pattern(fname, pattern):
                        key_files[category].append((rel_path, lines))
                        break

    return all_files, lang_stats, lang_lines, key_files, dir_tree


def print_report(repo_path: Path, all_files, lang_stats, lang_lines, key_files, dir_tree, top_n: int):
    """输出扫描报告"""

    total_files = len(all_files)
    total_lines = sum(f[2] for f in all_files)

    print("=" * 70)
    print(f"  代码仓库扫描报告: {repo_path.name}")
    print(f"  路径: {repo_path}")
    print("=" * 70)

    # 1. 基本统计
    print(f"\n## 1. 基本统计\n")
    print(f"| 指标 | 数值 |")
    print(f"|------|------|")
    print(f"| 总文件数 | {total_files} |")
    print(f"| 总代码行数 | {total_lines:,} |")
    print(f"| 语言种类 | {len(lang_stats)} |")

    # 2. 语言分布
    print(f"\n## 2. 语言分布\n")
    print(f"| 语言 | 文件数 | 代码行数 | 占比 |")
    print(f"|------|--------|---------|------|")
    for lang, count in lang_stats.most_common(15):
        lines = lang_lines[lang]
        pct = f"{lines / total_lines * 100:.1f}%" if total_lines > 0 else "0%"
        print(f"| {lang} | {count} | {lines:,} | {pct} |")

    # 3. 目录结构
    print(f"\n## 3. 目录结构（前 30 行）\n")
    print("```")
    for line in dir_tree[:30]:
        print(line)
    if len(dir_tree) > 30:
        print(f"  ... ({len(dir_tree) - 30} more directories)")
    print("```")

    # 4. 关键文件发现
    print(f"\n## 4. 关键文件发现\n")
    for category, files in key_files.items():
        if files:
            print(f"\n### {category} ({len(files)} 个)\n")
            # 去重并排序
            seen = set()
            for fpath, lines in sorted(files, key=lambda x: -x[1])[:10]:
                if fpath not in seen:
                    seen.add(fpath)
                    print(f"- `{fpath}` ({lines:,} 行)")

    # 5. 代码热点
    print(f"\n## 5. 代码热点 (Top {top_n})\n")
    print(f"| 排名 | 文件 | 行数 |")
    print(f"|------|------|------|")
    sorted_files = sorted(all_files, key=lambda x: -x[2])
    for i, (fpath, ext, lines) in enumerate(sorted_files[:top_n], 1):
        print(f"| {i} | `{fpath}` | {lines:,} |")

    print(f"\n{'=' * 70}")
    print(f"  扫描完成。共 {total_files} 个文件，{total_lines:,} 行代码。")
    print(f"{'=' * 70}")


def main():
    parser = argparse.ArgumentParser(description="代码仓库结构扫描与统计工具")
    parser.add_argument("repo_path", help="要扫描的仓库/目录路径")
    parser.add_argument("--depth", type=int, default=2, help="目录树深度 (默认 2)")
    parser.add_argument("--top", type=int, default=20, help="代码热点 Top N (默认 20)")
    args = parser.parse_args()

    repo_path = Path(args.repo_path).resolve()
    if not repo_path.is_dir():
        print(f"错误: {repo_path} 不是有效目录", file=sys.stderr)
        sys.exit(1)

    all_files, lang_stats, lang_lines, key_files, dir_tree = scan_repository(
        repo_path, depth=args.depth, top_n=args.top
    )
    print_report(repo_path, all_files, lang_stats, lang_lines, key_files, dir_tree, args.top)


if __name__ == "__main__":
    main()
