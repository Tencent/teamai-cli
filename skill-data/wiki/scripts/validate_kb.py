#!/usr/bin/env python3
"""
validate_kb.py: knowledge base quality validation tool

Purpose: in the Phase 4 quality assessment stage, automatically check the generated knowledge base for:
  1. Link integrity (dead link detection)
  2. search-anchor coverage
  3. AI Quick Reference table coverage
  4. Bidirectional link integrity
  5. README index coverage

Usage:
  python3 validate_kb.py /path/to/knowledge-base-dir
  python3 validate_kb.py /path/to/knowledge-base-dir --verbose
"""

import os
import re
import sys
import argparse
from pathlib import Path
from collections import defaultdict

# Markdown link regex: [text](path) or [text](path#anchor)
LINK_PATTERN = re.compile(r'\[([^\]]*)\]\(([^)]+)\)')
# search-anchor regex
ANCHOR_PATTERN = re.compile(r'<!--\s*search-anchor\s*:(.*?)-->', re.DOTALL)
# AI Quick Reference table regex. Matches both the current English heading and the
# legacy Chinese heading so knowledge bases built with earlier releases still validate.
# Legacy knowledge bases carry the Chinese heading; matched by code point so the source stays ASCII-only.
AI_TABLE_PATTERN = re.compile(r'##\s*🤖\s*AI\s*(?:Quick\s*Reference|\u5feb\u901f\u7406\u89e3)', re.IGNORECASE)
# Bidirectional link: a link back to the main / technical architecture document.
# Bilingual for the same reason as AI_TABLE_PATTERN.
BACK_LINK_PATTERN = re.compile(
    r'\[📘.*(?:Technical\s*Architecture|\u4e3b\u67b6\u6784|\u6280\u672f\u67b6\u6784)|Position in the overall architecture|\u5728\u6574\u4f53\u67b6\u6784\u4e2d\u7684\u4f4d\u7f6e',
    re.IGNORECASE,
)


def find_md_files(kb_dir: Path) -> list:
    """Find all .md files"""
    md_files = []
    for root, dirs, files in os.walk(kb_dir):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for f in files:
            if f.endswith('.md'):
                md_files.append(Path(root) / f)
    return sorted(md_files)


def check_links(md_file: Path, kb_dir: Path) -> list:
    """Check that the links in the file resolve"""
    broken = []
    try:
        content = md_file.read_text(encoding='utf-8', errors='ignore')
    except OSError:
        return [("READ_ERROR", str(md_file), "cannot read file")]

    for match in LINK_PATTERN.finditer(content):
        link_text = match.group(1)
        link_target = match.group(2)

        # Skip external links and anchor-only links
        if link_target.startswith(('http://', 'https://', 'mailto:', '#')):
            continue

        # Split path and anchor
        path_part = link_target.split('#')[0]
        if not path_part:
            continue

        # Resolve the relative path
        target_path = (md_file.parent / path_part).resolve()
        if not target_path.exists():
            rel = str(md_file.relative_to(kb_dir))
            broken.append((rel, link_target, link_text))

    return broken


def check_anchor(md_file: Path) -> bool:
    """Check whether the file contains a search-anchor"""
    try:
        content = md_file.read_text(encoding='utf-8', errors='ignore')
        return bool(ANCHOR_PATTERN.search(content))
    except OSError:
        return False


def check_ai_table(md_file: Path) -> bool:
    """Check whether the file contains the AI Quick Reference table"""
    try:
        content = md_file.read_text(encoding='utf-8', errors='ignore')
        return bool(AI_TABLE_PATTERN.search(content))
    except OSError:
        return False


def check_back_link(md_file: Path) -> bool:
    """Check whether the component document links back to the main architecture document"""
    try:
        content = md_file.read_text(encoding='utf-8', errors='ignore')
        return bool(BACK_LINK_PATTERN.search(content))
    except OSError:
        return False


def check_readme_coverage(kb_dir: Path, md_files: list) -> tuple:
    """Check whether the README indexes every .md file"""
    readme_path = kb_dir / "README.md"
    if not readme_path.exists():
        return [], md_files

    readme_content = readme_path.read_text(encoding='utf-8', errors='ignore')
    covered = []
    uncovered = []

    for f in md_files:
        if f.name == "README.md":
            continue
        # Check whether the README mentions this file
        fname_no_ext = f.stem
        if fname_no_ext in readme_content or f.name in readme_content:
            covered.append(f)
        else:
            uncovered.append(f)

    return covered, uncovered


def main():
    parser = argparse.ArgumentParser(description="Knowledge base quality validation tool")
    parser.add_argument("kb_dir", help="Path of the knowledge base directory")
    parser.add_argument("--verbose", "-v", action="store_true", help="Print details")
    args = parser.parse_args()

    kb_dir = Path(args.kb_dir).resolve()
    if not kb_dir.is_dir():
        print(f"Error: {kb_dir} is not a valid directory", file=sys.stderr)
        sys.exit(1)

    md_files = find_md_files(kb_dir)
    if not md_files:
        print(f"Warning: no .md files found in {kb_dir}")
        sys.exit(0)

    # Filter the component design documents (files starting with a number)
    component_docs = [f for f in md_files if re.match(r'^\d+_', f.name)]

    print("=" * 70)
    print(f"  Knowledge base quality validation report")
    print(f"  Directory: {kb_dir}")
    print(f"  Files: {len(md_files)} .md files ({len(component_docs)} component documents)")
    print("=" * 70)

    total_score = 0
    max_score = 0

    # 1. Link integrity
    print(f"\n## 1. Link integrity check\n")
    all_broken = []
    for f in md_files:
        broken = check_links(f, kb_dir)
        all_broken.extend(broken)

    if all_broken:
        print(f"❌ Found {len(all_broken)} dead links:")
        for src, target, text in all_broken[:20]:
            print(f"   {src} → [{text}]({target})")
        if len(all_broken) > 20:
            print(f"   ... and {len(all_broken) - 20} more")
    else:
        print(f"✅ All links valid ({len(md_files)} files checked)")
        total_score += 20
    max_score += 20

    # 2. search-anchor coverage
    print(f"\n## 2. Search-Anchor coverage\n")
    has_anchor = sum(1 for f in md_files if check_anchor(f))
    anchor_pct = has_anchor / len(md_files) * 100 if md_files else 0
    print(f"{'✅' if anchor_pct >= 80 else '⚠️'} {has_anchor}/{len(md_files)} files have a search-anchor ({anchor_pct:.0f}%)")
    if args.verbose:
        for f in md_files:
            if not check_anchor(f):
                print(f"   Missing: {f.relative_to(kb_dir)}")
    if anchor_pct >= 80:
        total_score += 20
    elif anchor_pct >= 50:
        total_score += 10
    max_score += 20

    # 3. AI Quick Reference table coverage (component documents only)
    print(f"\n## 3. AI Quick Reference table coverage (component documents)\n")
    if component_docs:
        has_ai_table = sum(1 for f in component_docs if check_ai_table(f))
        ai_pct = has_ai_table / len(component_docs) * 100
        print(f"{'✅' if ai_pct >= 90 else '⚠️'} {has_ai_table}/{len(component_docs)} component documents have an AI Quick Reference table ({ai_pct:.0f}%)")
        if args.verbose:
            for f in component_docs:
                if not check_ai_table(f):
                    print(f"   Missing: {f.relative_to(kb_dir)}")
        if ai_pct >= 90:
            total_score += 20
        elif ai_pct >= 60:
            total_score += 10
    else:
        print("⚠️ No numbered component documents found")
    max_score += 20

    # 4. Bidirectional link check (component documents link back to the main architecture)
    print(f"\n## 4. Bidirectional link check (component → main architecture)\n")
    if component_docs:
        has_back = sum(1 for f in component_docs if check_back_link(f))
        back_pct = has_back / len(component_docs) * 100
        print(f"{'✅' if back_pct >= 90 else '⚠️'} {has_back}/{len(component_docs)} component documents link back to the main architecture ({back_pct:.0f}%)")
        if back_pct >= 90:
            total_score += 20
        elif back_pct >= 60:
            total_score += 10
    else:
        print("⚠️ No numbered component documents found")
    max_score += 20

    # 5. README index coverage
    print(f"\n## 5. README index coverage\n")
    covered, uncovered = check_readme_coverage(kb_dir, md_files)
    if (kb_dir / "README.md").exists():
        cover_pct = len(covered) / (len(covered) + len(uncovered)) * 100 if (covered or uncovered) else 100
        print(f"{'✅' if cover_pct >= 90 else '⚠️'} README indexes {len(covered)}/{len(covered)+len(uncovered)} documents ({cover_pct:.0f}%)")
        if uncovered and args.verbose:
            print("   Not indexed:")
            for f in uncovered[:10]:
                print(f"     {f.relative_to(kb_dir)}")
        if cover_pct >= 90:
            total_score += 20
        elif cover_pct >= 60:
            total_score += 10
    else:
        print("❌ README.md not found")
    max_score += 20

    # Summary
    final_pct = total_score / max_score * 100 if max_score else 0
    print(f"\n{'=' * 70}")
    print(f"  Overall score: {total_score}/{max_score} ({final_pct:.0f}%)")
    if final_pct >= 90:
        print(f"  Rating: ✅ Excellent. The knowledge base meets the quality bar")
    elif final_pct >= 70:
        print(f"  Rating: ⚠️ Good. Fixing the issues above is recommended")
    else:
        print(f"  Rating: ❌ Needs improvement. There are many quality issues")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
