#!/usr/bin/env python3
"""Render scb-check's JSON report as a Markdown block.

Used by .github/workflows/code-erosion.yml. Reads the report path and the
scb-check exit code from argv, writes Markdown to stdout. The workflow feeds
that Markdown both into the PR comment and the job summary.

This never raises on a missing/garbled report or a renamed key: the workflow
is informational and must not fail. See docs/ci-code-erosion.md.
"""

from __future__ import annotations

import json
import sys

MARKER = "<!-- code-erosion-report -->"


def band(value: float, human_hi: float, agent_lo: float) -> str:
    """Bucket a metric against the SlopCodeBench reference bands."""
    if value <= human_hi:
        return "human"
    if value >= agent_lo:
        return "agent"
    return "between"


def main() -> int:
    report_path = sys.argv[1]
    exit_code = sys.argv[2] if len(sys.argv) > 2 else "0"

    out: list[str] = [
        MARKER,
        "## Code Erosion Report (informational)",
        "",
        "Reported by `scb-check==0.2.0` (SlopCodeBench metrics). "
        "**This never blocks CI.**",
        "",
    ]

    try:
        with open(report_path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as error:
        out.append(
            f"> scb-check produced no parseable report (exit {exit_code}): "
            f"`{error}`",
        )
        print("\n".join(out))
        return 0

    if exit_code == "2":
        out.append(
            "> **Warning:** scb-check exited 2 (path/config error). "
            "Numbers below may be incomplete.",
        )
        out.append("")

    # scb-check's JSON keys are pinned via the 0.2.0 version pin, but a future
    # bump could rename one. Never crash on that — this report must not block
    # CI, so a missing key degrades to a warning instead of an exception.
    try:
        verbosity = float(data["verbosity"])
        erosion = float(data["erosion"])
        cog_erosion = float(data["cog_erosion"])
        files_scanned = data["files_scanned"]
        total_loc = data["total_loc"]
        high_cc = data["high_cc_functions"]
        total_functions = data["total_functions"]
    except (KeyError, TypeError, ValueError) as error:
        out.append(
            f"> scb-check report is missing an expected field (`{error}`). "
            "The tool version may have changed its JSON schema; update "
            "`.github/scripts/erosion-summary.py`.",
        )
        print("\n".join(out))
        return 0

    out.extend(
        [
            "| Metric | Value | Human band | Agent band | Reading |",
            "|---|---|---|---|---|",
            f"| Verbosity\\* | {verbosity:.3f} | 0.15 | 0.33 | "
            f"{band(verbosity, 0.21, 0.23)} |",
            f"| Erosion | {erosion:.3f} | 0.31 | 0.68 | "
            f"{band(erosion, 0.48, 0.48)} |",
            f"| Cognitive erosion | {cog_erosion:.3f} | – | – | – |",
            "",
            f"Scanned {files_scanned} files / {total_loc} SLOC "
            f"· high-CC functions {high_cc}/{total_functions}",
            "",
            "\\* On TypeScript, `verbosity` covers clone + wrapper detection "
            "only (scb-check's 197 ast-grep rules are Python-only). `erosion` "
            "is faithful. Reference bands are Python-calibrated — read them "
            "as direction, not verdict. See `docs/ci-code-erosion.md`.",
        ],
    )

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
