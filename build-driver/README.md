# build-driver/ — Symphony Cloud (symphony-claude) config

Config for the **build driver** that implements the Linear backlog (Phase 2A of the
RUNBOOK). The driver is [`symphony-claude`](https://github.com/mscalessio/symphony-claude),
a TypeScript reimplementation of Symphony that polls Linear and launches a Claude Code
agent per ticket.

> This drives the **construction** of the product. It is not the product's own
> `WORKFLOW.md` (that one polls Notion and is a build deliverable).

## Files

- **`WORKFLOW.md`** — the driver config: Linear project `d27271e017ad`, active/terminal
  states, target-repo clone hook, and the per-ticket prompt (build contract + Definition
  of Done + status map).
- **`notion.mcp.json`** — *optional* fallback so agents reach Notion via a local MCP
  server + `NOTION_API_KEY` instead of your connected claude.ai Notion connector.

## Run

```bash
# 1. Build the driver once
cd ../symphony-claude && npm install && npm run build && cd -

# 2. Export creds into the driver shell (claude must be authenticated)
set -a; . ./.env; set +a          # LINEAR_API_KEY (+ NOTION_API_KEY only if using the fallback)

# 3. Start it, pointing at this WORKFLOW.md
node ../symphony-claude/dist/index.js "$PWD/build-driver/WORKFLOW.md" --port 3000
```

Watch: TUI on the terminal, web dashboard at http://localhost:3000/, and each agent's
`## Workpad` comment on its Linear ticket. It claims ARK-49 (Wave 0) first.

## Notion access for the SYM-004 / SYM-006 / SYM-007 agents

Those tickets' required tests hit a real Notion board. Two ways to give agents Notion MCP:

1. **Connector (default, zero-setup):** agents inherit your `claude.ai Notion` MCP
   connector (`claude mcp list` shows it Connected). symphony-claude does not pass
   `--strict-mcp-config`, so user-scope servers load. No `NOTION_API_KEY` needed.
2. **Local server (robust/reproducible fallback):** copy `notion.mcp.json` to the target
   repo root as `.mcp.json` (or write it from `hooks.after_create`), and export
   `NOTION_API_KEY`. Use this for unattended runs or fresh machines where the OAuth
   connector isn't present / could expire mid-run.
