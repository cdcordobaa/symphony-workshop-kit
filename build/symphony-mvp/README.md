# symphony-mvp

Walking-skeleton implementation of the Symphony orchestrator (Notion tracker +
Claude Code agent), TypeScript / Node.js. This is the **U1 foundation slice**:
CLI/host lifecycle, `WORKFLOW.md` loader, typed config (Notion variant), shared
domain types + cross-unit interfaces, and a strict prompt renderer.

## Scripts

```sh
npm install
npm run build     # tsc -> dist/
npm test          # vitest
npm start -- ./WORKFLOW.md   # run the host (positional path optional)
```

## Layout (U1)

- `src/index.ts` — CLI entrypoint / host lifecycle (`boot`, `main`). FR-CLI-1.
- `src/domain/` — shared types + the cross-unit interfaces later units implement:
  - `Issue` / `BlockerRef` / `IssueStateRef` (§4.1.1)
  - `ServiceConfig` + `WorkflowDefinition` (§4.1.3, §4.1.2)
  - `OrchestratorRuntimeState` (§4.1.8) via `createRuntimeState`
  - `TrackerClient` (U2), `AgentRunner` + `WorkspaceManager` (U4) interfaces
  - `SymphonyError` typed error surface
- `src/config/` — `loadWorkflow`, `buildServiceConfig`, `$VAR`/path resolution,
  and `validateDispatchConfig` / `assertDispatchConfig` preflight. FR-WL-1,2,3,6,7.
- `src/prompt/render.ts` — strict Liquid `renderPrompt(template, issue, attempt)`.
  Unknown variables/filters fail. FR-WL-5 / FR-PR-1.

## For later units

Import contracts from the barrels — do **not** redefine them:

```ts
import {
  Issue, ServiceConfig, OrchestratorRuntimeState,
  TrackerClient, AgentRunner, WorkspaceManager,
} from "./domain/index.js";
import { loadWorkflow, validateDispatchConfig } from "./config/index.js";
import { renderPrompt } from "./prompt/index.js";
```

`WORKFLOW.md` front matter is the Notion variant (`requirements.md §7`):
`tracker.kind: notion`, `tracker.database`, `tracker.api_key` (`$VAR`),
`polling`, `workspace`, `hooks`, `agent` (`codex.*` repurposed to `agent.*`).
Set `NOTION_API_KEY` / `NOTION_DATABASE_ID` to satisfy preflight with the
bundled sample `WORKFLOW.md`.
