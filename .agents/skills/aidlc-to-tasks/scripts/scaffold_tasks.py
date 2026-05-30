#!/usr/bin/env python3
"""Scaffold empty task-file stubs from a task-package.yaml manifest.

Reads the `tasks:` list from docs/tasks/task-package.yaml and creates one stub
Markdown file per task that does not already exist, pre-filled with the required
frontmatter keys and body section headers expected by `convert-tasks-to-linear`.

This is a convenience for the `aidlc-to-tasks` skill: it removes boilerplate
typing. It is intentionally dependency-free (stdlib only) and NEVER overwrites an
existing file. The authoritative validator remains:

    uv run --script .agents/skills/convert-tasks-to-linear/scripts/convert_tasks_to_linear.py \
      validate --manifest docs/tasks/task-package.yaml

Usage:
    python3 .agents/skills/aidlc-to-tasks/scripts/scaffold_tasks.py \
      --manifest docs/tasks/task-package.yaml
"""
from __future__ import annotations

import argparse
import os
import re
import sys


def load_manifest(path: str) -> dict:
    """Parse the small, predictable task-package.yaml structure.

    Prefers PyYAML if importable; otherwise uses a minimal parser that handles
    the flat manifest shape (planningWave, tasksDir, milestones[], tasks[]).
    """
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    try:
        import yaml  # type: ignore

        return yaml.safe_load(text) or {}
    except Exception:
        return _mini_parse(text)


def _mini_parse(text: str) -> dict:
    data: dict = {"milestones": [], "tasks": []}
    section = None
    pending_id = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        if re.match(r"^milestones:\s*$", line):
            section = "milestones"
            continue
        if re.match(r"^tasks:\s*$", line):
            section = "tasks"
            continue
        m = re.match(r"^(\w+):\s*(.+)$", line)
        if m and not line.startswith(" ") and not line.lstrip().startswith("-"):
            data[m.group(1)] = m.group(2).strip().strip('"')
            section = None
            continue
        if section == "milestones":
            mm = re.match(r"^\s*-\s*(.+)$", line)
            if mm:
                data["milestones"].append(mm.group(1).strip().strip('"'))
        elif section == "tasks":
            mid = re.match(r"^\s*-\s*id:\s*(.+)$", line)
            mfile = re.match(r"^\s*file:\s*(.+)$", line)
            if mid:
                pending_id = mid.group(1).strip().strip('"')
            elif mfile and pending_id is not None:
                data["tasks"].append(
                    {"id": pending_id, "file": mfile.group(1).strip().strip('"')}
                )
                pending_id = None
    return data


STUB = """---
id: {id}
title: {title}
milestone: "{milestone}"
priority: 3
estimate: 3
blockedBy: []
blocks: []
parent: null
---

## Summary

<!-- 1-2 sentences. Which SPEC section / working unit does this implement? -->

## Scope

### In scope

- TODO

### Out of scope

- TODO

## Deliverables

- TODO

## Acceptance Criteria

- [ ] TODO: measurable outcome (one per mapped functional requirement / behavior)

## Test Plan

- TODO: concrete build/test command for the chosen stack

## Context

- Read `spec/SYMPHONY-SPEC.md` §<section>.
- Source working unit: aidlc-docs/inception/application-design/unit-of-work.md
- Repo paths to inspect or create: TODO

## Definition of Ready

- [ ] Hidden assumptions from prior discussion are written down.
- [ ] Required files, docs, and dependencies are explicitly referenced.
- [ ] A coding agent could begin execution without additional planning context.

## Notes

<!-- Record any inference made while mapping from AI-DLC artifacts. -->
"""


def title_from_file(path: str) -> str:
    base = os.path.splitext(os.path.basename(path))[0]
    base = re.sub(r"^[A-Za-z]+-\d+-", "", base)  # strip "SYM-001-"
    return base.replace("-", " ").replace("_", " ").title()


def main() -> int:
    ap = argparse.ArgumentParser(description="Scaffold task-file stubs from a manifest.")
    ap.add_argument("--manifest", required=True)
    args = ap.parse_args()

    if not os.path.exists(args.manifest):
        print(f"error: manifest not found: {args.manifest}", file=sys.stderr)
        return 1

    data = load_manifest(args.manifest)
    tasks = data.get("tasks") or []
    milestones = data.get("milestones") or []
    default_milestone = milestones[0] if milestones else "M1: TODO"

    if not tasks:
        print("error: no tasks found in manifest", file=sys.stderr)
        return 1

    created, skipped = [], []
    for task in tasks:
        tid = task.get("id")
        tfile = task.get("file")
        if not tid or not tfile:
            print(f"warning: skipping malformed task entry: {task!r}", file=sys.stderr)
            continue
        if os.path.exists(tfile):
            skipped.append(tfile)
            continue
        os.makedirs(os.path.dirname(tfile) or ".", exist_ok=True)
        with open(tfile, "w", encoding="utf-8") as fh:
            fh.write(
                STUB.format(
                    id=tid,
                    title=title_from_file(tfile),
                    milestone=default_milestone,
                )
            )
        created.append(tfile)

    print(f"created {len(created)} stub(s), skipped {len(skipped)} existing file(s)")
    for f in created:
        print(f"  + {f}")
    for f in skipped:
        print(f"  = {f} (exists, untouched)")
    print(
        "\nNext: fill each stub per the mapping table, then validate with "
        "convert_tasks_to_linear.py validate."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
