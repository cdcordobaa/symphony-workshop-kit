/**
 * Domain-layer specs (ARK-58 / SYM-001).
 *
 * Two jobs, and they are enforced by different tools — worth being explicit, because
 * the split is easy to get wrong:
 *
 *   - The *type-level* acceptance criteria ("all five ports are exported and
 *     reference only domain types") are enforced by `tsc`, via `npm run typecheck`,
 *     which includes `test/**` in its program. The stub classes below are the
 *     permanent form of the task file's "throwaway file importing each port".
 *     `npm test` runs under `tsx`, which *strips* types without checking them, so it
 *     can never fail on a type error.
 *
 *   - The *runtime-observable* criteria (the §4.1.1 field set, FR5's required seven)
 *     are asserted here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AgentRunner,
  Issue,
  Logger,
  LogContext,
  OrchestratorState,
  RunAttempt,
  StatusSurface,
  TrackerClient,
  Workspace,
  WorkspaceManager,
} from "../src/domain/index.js";

/** A fully populated §4.1.1 issue, used as the shape oracle. */
const sampleIssue: Issue = {
  id: "issue_0d1ccaf5",
  identifier: "ARK-58",
  title: "Project Initialization And Core Domain Models",
  description: "Scaffold the project and define the §4 domain model.",
  priority: 1,
  state: "In Progress",
  branch_name: "arkatechie/ark-58-project-initialization-and-core-domain-models",
  url: "https://linear.app/arkatechie/issue/ARK-58",
  labels: ["foundation"],
  blocked_by: [],
  created_at: "2026-09-15T00:47:14.090Z",
  updated_at: "2026-09-15T00:54:53.984Z",
};

describe("§4.1.1 Issue", () => {
  it("populates every field FR5 requires the tracker adapter to produce", () => {
    // FR5: `id, identifier, title, state, priority, labels, blocked_by`.
    for (const field of [
      "id",
      "identifier",
      "title",
      "state",
      "priority",
      "labels",
      "blocked_by",
    ] as const) {
      assert.ok(field in sampleIssue, `FR5 field missing from Issue: ${field}`);
    }
  });

  it("carries the wider §4.1.1 fields the downstream units depend on", () => {
    // `description`/`url` are rendered by the strict prompt template (§12.2) and
    // `created_at` is the secondary dispatch sort key (§8.2). Dropping them to the
    // literal FR5 seven would break ARK-63 and ARK-64.
    for (const field of ["description", "url", "created_at", "updated_at", "branch_name"] as const) {
      assert.ok(field in sampleIssue, `§4.1.1 field missing from Issue: ${field}`);
    }
  });

  it("matches the §4.1.1 field set exactly — no drift in either direction", () => {
    assert.deepEqual(Object.keys(sampleIssue).sort(), [
      "blocked_by",
      "branch_name",
      "created_at",
      "description",
      "id",
      "identifier",
      "labels",
      "priority",
      "state",
      "title",
      "updated_at",
      "url",
    ]);
  });

  it("models a blocker ref with every field nullable (§4.1.1)", () => {
    const blocked: Issue = {
      ...sampleIssue,
      blocked_by: [{ id: null, identifier: "ARK-57", state: "Done" }],
    };
    assert.equal(blocked.blocked_by[0]?.identifier, "ARK-57");
    assert.equal(blocked.blocked_by[0]?.id, null);
  });
});

describe("§4.1.8 OrchestratorState", () => {
  it("is in-memory only: sets and maps, no persistence handle (§5.4)", () => {
    const state: OrchestratorState = {
      poll_interval_ms: 30_000,
      max_concurrent_agents: 10,
      running: {},
      claimed: new Set<string>(),
      completed: new Set<string>(),
    };
    state.claimed.add(sampleIssue.id);
    assert.ok(state.claimed.has(sampleIssue.id));
    assert.equal(Object.keys(state.running).length, 0);
  });
});

describe("port interfaces", () => {
  // Each stub exists so `tsc` proves the interface is implementable using domain
  // types alone. If a port ever leaks a concrete dependency, `npm run typecheck`
  // fails here rather than in the unit that first tries to implement it.

  class StubTracker implements TrackerClient {
    async fetchCandidateIssues(): Promise<Issue[]> {
      return [sampleIssue];
    }
    async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
      return stateNames.includes(sampleIssue.state) ? [sampleIssue] : [];
    }
    async fetchIssueStatesByIds(issueIds: string[]): Promise<Record<string, string>> {
      return Object.fromEntries(issueIds.map((id) => [id, sampleIssue.state]));
    }
  }

  class StubWorkspaces implements WorkspaceManager {
    workspacePathFor(identifier: string): string {
      return `/tmp/symphony_workspaces/${identifier}`;
    }
    async prepare(identifier: string): Promise<Workspace> {
      return {
        path: this.workspacePathFor(identifier),
        workspace_key: identifier,
        created_now: true,
      };
    }
    async remove(): Promise<void> {}
  }

  class StubRunner implements AgentRunner {
    async run(issue: Issue, attempt: number | null): Promise<RunAttempt> {
      return {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        attempt,
        workspace_path: `/tmp/symphony_workspaces/${issue.identifier}`,
        started_at: new Date(0).toISOString(),
        status: "succeeded",
      };
    }
  }

  class StubLogger implements Logger {
    readonly records: Array<[string, LogContext | undefined]> = [];
    debug(message: string, context?: LogContext): void {
      this.records.push([message, context]);
    }
    info(message: string, context?: LogContext): void {
      this.records.push([message, context]);
    }
    warn(message: string, context?: LogContext): void {
      this.records.push([message, context]);
    }
    error(message: string, context?: LogContext): void {
      this.records.push([message, context]);
    }
    child(): Logger {
      return this;
    }
  }

  class StubStatus implements StatusSurface {
    rendered = 0;
    render(_state: OrchestratorState): void {
      this.rendered += 1;
    }
    stop(): void {}
  }

  it("TrackerClient exposes the three §11.1 REQUIRED operations", async () => {
    const tracker = new StubTracker();
    assert.deepEqual(await tracker.fetchCandidateIssues(), [sampleIssue]);
    assert.deepEqual(await tracker.fetchIssuesByStates(["Backlog"]), []);
    assert.deepEqual(await tracker.fetchIssueStatesByIds([sampleIssue.id]), {
      [sampleIssue.id]: "In Progress",
    });
  });

  it("WorkspaceManager reports whether the directory was created now (§9.4 gate)", async () => {
    const workspace = await new StubWorkspaces().prepare("ARK-58");
    assert.equal(workspace.created_now, true);
    assert.equal(workspace.workspace_key, "ARK-58");
  });

  it("AgentRunner returns a RunAttempt with attempt=null on a first run (§12.3)", async () => {
    const attempt = await new StubRunner().run(sampleIssue, null);
    assert.equal(attempt.attempt, null);
    assert.equal(attempt.issue_identifier, "ARK-58");
    assert.equal(attempt.status, "succeeded");
  });

  it("Logger accepts the §13.1 REQUIRED context fields", () => {
    const logger = new StubLogger();
    logger.info("dispatch outcome=completed", {
      issue_id: sampleIssue.id,
      issue_identifier: sampleIssue.identifier,
      session_id: "thread_1-turn_1",
    });
    assert.equal(logger.records.length, 1);
    assert.equal(logger.records[0]?.[1]?.session_id, "thread_1-turn_1");
  });

  it("StatusSurface draws from orchestrator state only (§13.4)", () => {
    const surface = new StubStatus();
    surface.render({
      poll_interval_ms: 30_000,
      max_concurrent_agents: 10,
      running: {},
      claimed: new Set(),
      completed: new Set(),
    });
    surface.stop();
    assert.equal(surface.rendered, 1);
  });
});
