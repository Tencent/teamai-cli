#!/usr/bin/env python3
"""
validate_kb.py — 知识库质量校验工具

用途: Phase 4 质量评估阶段，自动校验已生成知识库的：
  1. 链接完整性（检测死链接）
  2. search-anchor 覆盖率
  3. AI 快速理解表覆盖率
  4. 双向链接完整性
  5. README 索引收录率

使用方式:
  python3 validate_kb.py /path/to/knowledge-base-dir
  python3 validate_kb.py /path/to/knowledge-base-dir --verbose
"""

import os
import re
import sys
import argparse
from pathlib import Path
from collections import defaultdict

# Markdown 链接正则: [text](path) 或 [text](path#anchor)
LINK_PATTERN = re.compile(r'\[([^\]]*)\]\(([^)]+)\)')
# search-anchor 正则
ANCHOR_PATTERN = re.compile(r'<!--\s*search-anchor\s*:(.*?)-->', re.DOTALL)
# AI 快速理解表正则
AI_TABLE_PATTERN = re.compile(r'##\s*🤖\s*AI\s*快速理解', re.IGNORECASE)
# 双向链接: 链接回主架构/技术架构文档
BACK_LINK_PATTERN = re.compile(r'\[📘.*(?:主架构|技术架构)|在整体架构中的位置', re.IGNORECASE)


def find_md_files(kb_dir: Path) -> list:
    """查找所有 .md 文件"""
    md_files = []
    for root, dirs, files in os.walk(kb_dir):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for f in files:
            if f.endswith('.md'):
                md_files.append(Path(root) / f)
    return sorted(md_files)


def check_links(md_file: Path, kb_dir: Path) -> list:
    """检查文件中的链接是否有效"""
    broken = []
    try:
        content = md_file.read_text(encoding='utf-8', errors='ignore')
    except OSError:
        return [("READ_ERROR", str(md_file), "无法读取文件")]

    for match in LINK_PATTERN.finditer(content):
        link_text = match.group(1)
        link_target = match.group(2)

        # 跳过外部链接和锚点链接
        if link_target.startswith(('http://', 'https://', 'mailto:', '#')):
            continue

        # 分离路径和锚点
        path_part = link_target.split('#')[0]
        if not path_part:
            continue

        # 解析相对路径
        target_path = (md_file.parent / path_part).resolve()
        if not target_path.exists():
            rel = str(md_file.relative_to(kb_dir))
            broken.append((rel, link_target, link_text))

    return broken


def check_anchor(md_file: Path) -> bool:
    """检查文件是否包含 search-anchor"""
    try:
        content = md_file.read_text(encoding='utf-8', errors='ignore')
        return bool(ANCHOR_PATTERN.search(content))
    except OSError:
        return False


def check_ai_table(md_file: Path) -> bool:
    """检查文件是否包含 AI 快速理解表"""
    try:
        content = md_file.read_text(encoding='utf-8', errors='ignore')
        return bool(AI_TABLE_PATTERN.search(content))
    except OSError:
        return False


def check_back_link(md_file: Path) -> bool:
    """检查组件文档是否有链接回主架构文档"""
    try:
        content = md_file.read_text(encoding='utf-8', errors='ignore')
        return bool(BACK_LINK_PATTERN.search(content))
    except OSError:
        return False


def check_readme_coverage(kb_dir: Path, md_files: list) -> tuple:
    """检查 README 是否收录了所有 .md 文件"""
    readme_path = kb_dir / "README.md"
    if not readme_path.exists():
        return [], md_files

    readme_content = readme_path.read_text(encoding='utf-8', errors='ignore')
    covered = []
    uncovered = []

    for f in md_files:
        if f.name == "README.md":
            continue
        # 检查 README 中是否提到了这个文件
        fname_no_ext = f.stem
        if fname_no_ext in readme_content or f.name in readme_content:
            covered.append(f)
        else:
            uncovered.append(f)

    return covered, uncovered


def main():
    parser = argparse.ArgumentParser(description="知识库质量校验工具")
    parser.add_argument("kb_dir", help="知识库目录路径")
    parser.add_argument("--verbose", "-v", action="store_true", help="输出详细信息")
    args = parser.parse_args()

    kb_dir = Path(args.kb_dir).resolve()
    if not kb_dir.is_dir():
        print(f"错误: {kb_dir} 不是有效目录", file=sys.stderr)
        sys.exit(1)

    md_files = find_md_files(kb_dir)
    if not md_files:
        print(f"警告: {kb_dir} 中未找到任何 .md 文件")
        sys.exit(0)

    # 过滤出组件设计文档（以数字编号开头的文件）
    component_docs = [f for f in md_files if re.match(r'^\d+_', f.name)]

    print("=" * 70)
    print(f"  知识库质量校验报告")
    print(f"  目录: {kb_dir}")
    print(f"  文件数: {len(md_files)} 个 .md 文件 (其中 {len(component_docs)} 个组件文档)")
    print("=" * 70)

    total_score = 0
    max_score = 0

    # 1. 链接完整性
    print(f"\n## 1. 链接完整性检查\n")
    all_broken = []
    for f in md_files:
        broken = check_links(f, kb_dir)
        all_broken.extend(broken)

    if all_broken:
        print(f"❌ 发现 {len(all_broken)} 个死链接:")
        for src, target, text in all_broken[:20]:
            print(f"   {src} → [{text}]({target})")
        if len(all_broken) > 20:
            print(f"   ... 还有 {len(all_broken) - 20} 个")
    else:
        print(f"✅ 所有链接有效 (检查了 {len(md_files)} 个文件)")
        total_score += 20
    max_score += 20

    # 2. search-anchor 覆盖率
    print(f"\n## 2. Search-Anchor 覆盖率\n")
    has_anchor = sum(1 for f in md_files if check_anchor(f))
    anchor_pct = has_anchor / len(md_files) * 100 if md_files else 0
    print(f"{'✅' if anchor_pct >= 80 else '⚠️'} {has_anchor}/{len(md_files)} 个文件有 search-anchor ({anchor_pct:.0f}%)")
    if args.verbose:
        for f in md_files:
            if not check_anchor(f):
                print(f"   缺失: {f.relative_to(kb_dir)}")
    if anchor_pct >= 80:
        total_score += 20
    elif anchor_pct >= 50:
        total_score += 10
    max_score += 20

    # 3. AI 快速理解表覆盖率（仅检查组件文档）
    print(f"\n## 3. AI 快速理解表覆盖率 (组件文档)\n")
    if component_docs:
        has_ai_table = sum(1 for f in component_docs if check_ai_table(f))
        ai_pct = has_ai_table / len(component_docs) * 100
        print(f"{'✅' if ai_pct >= 90 else '⚠️'} {has_ai_table}/{len(component_docs)} 个组件文档有 AI 快速理解表 ({ai_pct:.0f}%)")
        if args.verbose:
            for f in component_docs:
                if not check_ai_table(f):
                    print(f"   缺失: {f.relative_to(kb_dir)}")
        if ai_pct >= 90:
            total_score += 20
        elif ai_pct >= 60:
            total_score += 10
    else:
        print("⚠️ 未发现编号开头的组件文档")
    max_score += 20

    # 4. 双向链接检查（组件文档是否链接回主架构）
    print(f"\n## 4. 双向链接检查 (组件→主架构)\n")
    if component_docs:
        has_back = sum(1 for f in component_docs if check_back_link(f))
        back_pct = has_back / len(component_docs) * 100
        print(f"{'✅' if back_pct >= 90 else '⚠️'} {has_back}/{len(component_docs)} 个组件文档有回链到主架构 ({back_pct:.0f}%)")
        if back_pct >= 90:
            total_score += 20
        elif back_pct >= 60:
            total_score += 10
    else:
        print("⚠️ 未发现编号开头的组件文档")
    max_score += 20

    # 5. README 索引覆盖率
    print(f"\n## 5. README 索引覆盖率\n")
    covered, uncovered = check_readme_coverage(kb_dir, md_files)
    if (kb_dir / "README.md").exists():
        cover_pct = len(covered) / (len(covered) + len(uncovered)) * 100 if (covered or uncovered) else 100
        print(f"{'✅' if cover_pct >= 90 else '⚠️'} README 收录了 {len(covered)}/{len(covered)+len(uncovered)} 个文档 ({cover_pct:.0f}%)")
        if uncovered and args.verbose:
            print("   未收录:")
            for f in uncovered[:10]:
                print(f"     {f.relative_to(kb_dir)}")
        if cover_pct >= 90:
            total_score += 20
        elif cover_pct >= 60:
            total_score += 10
    else:
        print("❌ 未找到 README.md")
    max_score += 20

    # 总结
    final_pct = total_score / max_score * 100 if max_score else 0
    print(f"\n{'=' * 70}")
    print(f"  综合评分: {total_score}/{max_score} ({final_pct:.0f}%)")
    if final_pct >= 90:
        print(f"  评级: ✅ 优秀 — 知识库质量达标")
    elif final_pct >= 70:
        print(f"  评级: ⚠️ 良好 — 建议修复上述问题")
    else:
        print(f"  评级: ❌ 需改进 — 存在较多质量问题")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
