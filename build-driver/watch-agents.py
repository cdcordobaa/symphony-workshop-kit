#!/usr/bin/env python3
"""
Stream every spawned Symphony agent's execution, labeled by issue.

Whichever driver you use (symphony-claude or the Symphony Notion engine), each
agent is a `claude -p` process whose full transcript — every tool call, Bash
command, file write, and assistant note — is written by Claude Code to
`~/.claude/projects/<escaped-workspace-path>/<session>.jsonl`. This tails all of
them at once and prints a live, per-agent command feed.

Usage:
    python3 build-driver/watch-agents.py            # follow new activity (like tail -f)
    python3 build-driver/watch-agents.py --history  # also print each transcript's backlog first

Stop with Ctrl-C. Read-only; watches files, changes nothing.
"""
import os, glob, json, time, sys

HOME = os.path.expanduser("~")
PROJECTS = os.path.join(HOME, ".claude", "projects")
# Claude escapes a workspace path (e.g. /Users/me/symphony-workspaces/ARK-56)
# into a project dir name like "-Users-me-symphony-workspaces-ARK-56". Match every
# Symphony agent workspace layout: symphony-claude (~/symphony-workspaces),
# the product runtime (~/.symphony/workspaces), and the product build
# (~/.symphony/build-workspaces). Common shape: contains "symphony" AND "workspaces".
FROM_START = "--history" in sys.argv


def _is_agent_dir(base: str) -> bool:
    return "symphony" in base and "workspaces" in base

COLORS = ["\033[36m", "\033[32m", "\033[33m", "\033[35m", "\033[34m", "\033[31m"]
RESET = "\033[0m"
_assigned: dict[str, str] = {}


def color(label: str) -> str:
    if label not in _assigned:
        _assigned[label] = COLORS[len(_assigned) % len(COLORS)]
    return _assigned[label]


def issue_of(dirname: str) -> str:
    # ...-symphony-workspaces-ARK-56 / ...-symphony-build-workspaces-DEV-3  ->  ARK-56 / DEV-3
    return dirname.split("workspaces-", 1)[-1] if "workspaces-" in dirname else dirname


def transcript_files():
    for d in glob.glob(os.path.join(PROJECTS, "*workspaces*")):
        if not _is_agent_dir(os.path.basename(d)):
            continue
        for f in glob.glob(os.path.join(d, "*.jsonl")):
            yield issue_of(os.path.basename(d)), f


def render(issue: str, obj: dict):
    msg = obj.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        return
    c = color(issue)
    for b in content:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "tool_use":
            name, inp = b.get("name", "?"), b.get("input", {}) or {}
            if name == "Bash":
                detail = "$ " + str(inp.get("command", "")).replace("\n", " ")[:200]
            elif name in ("Write", "Edit", "Read", "NotebookEdit"):
                detail = str(inp.get("file_path", ""))
            elif name == "TodoWrite":
                detail = "(plan update)"
            elif "linear" in name.lower():
                detail = str(inp.get("query", inp))[:160]
            else:
                detail = json.dumps(inp)[:160]
            print(f"{c}[{issue:<8}]{RESET} {name:<10} {detail}", flush=True)
        elif t == "text" and msg.get("role") == "assistant":
            txt = " ".join(b.get("text", "").split())
            if txt:
                print(f"{c}[{issue:<8}]{RESET} 💬 {txt[:200]}", flush=True)


def main():
    offsets: dict[str, int] = {}
    print(f"watching agent transcripts under {PROJECTS}/*{MATCH}*  (Ctrl-C to stop)\n", flush=True)
    first = True
    while True:
        for issue, f in transcript_files():
            try:
                size = os.path.getsize(f)
            except OSError:
                continue
            if f not in offsets:
                offsets[f] = 0 if (FROM_START or first) else size
            if size < offsets[f]:  # file rotated/truncated
                offsets[f] = 0
            if size > offsets[f]:
                with open(f, "r") as fh:
                    fh.seek(offsets[f])
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            render(issue, json.loads(line))
                        except json.JSONDecodeError:
                            pass
                    offsets[f] = fh.tell()
        first = False
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped.")
