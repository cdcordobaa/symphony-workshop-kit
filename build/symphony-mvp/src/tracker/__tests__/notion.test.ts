import { describe, expect, it } from "vitest";
import { Logger, MemorySink } from "../../obs/log.js";
import type { TrackerConfig } from "../../domain/config.js";
import { NotionTracker } from "../notion.js";
import type { NotionPage } from "../normalize.js";
import type {
  NotionMcpTransport,
  NotionQueryPage,
  NotionQueryParams,
} from "../transport.js";

const fixedNow = () => new Date("2026-06-02T12:00:00.000Z");

function makeLogger() {
  const sink = new MemorySink();
  const logger = new Logger({ level: "debug", sinks: [sink], now: fixedNow });
  return { logger, sink };
}

function trackerConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: "notion",
    database: "db_123",
    api_key: "secret_token",
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Done", "Cancelled"],
    ...overrides,
  };
}

function statusPage(id: string, status: string, extra: Partial<NotionPage> = {}): NotionPage {
  return {
    id,
    properties: {
      Name: { title: [{ plain_text: `Title ${id}` }] },
      Status: { status: { name: status } },
      ID: { rich_text: [{ plain_text: id.toUpperCase() }] },
    },
    ...extra,
  };
}

/** Configurable in-memory transport. Records calls; performs no writes. */
class MockTransport implements NotionMcpTransport {
  queryCalls: NotionQueryParams[] = [];
  fetchCalls: string[][] = [];
  private readonly pagesByCursor: Map<string | null, NotionQueryPage>;
  private readonly byId: Map<string, NotionPage>;
  queryError: Error | null = null;
  fetchError: Error | null = null;

  constructor(
    pages: NotionQueryPage[] = [],
    byId: Record<string, NotionPage> = {},
  ) {
    this.pagesByCursor = new Map();
    let cursor: string | null = null;
    for (const p of pages) {
      this.pagesByCursor.set(cursor, p);
      cursor = p.next_cursor;
    }
    this.byId = new Map(Object.entries(byId));
  }

  queryDatabase(params: NotionQueryParams): Promise<NotionQueryPage> {
    this.queryCalls.push(params);
    if (this.queryError) return Promise.reject(this.queryError);
    const page = this.pagesByCursor.get(params.startCursor);
    if (!page) {
      return Promise.resolve({ pages: [], next_cursor: null, has_more: false });
    }
    return Promise.resolve(page);
  }

  fetchPagesByIds(ids: string[]): Promise<NotionPage[]> {
    this.fetchCalls.push(ids);
    if (this.fetchError) return Promise.reject(this.fetchError);
    return Promise.resolve(
      ids.map((id) => this.byId.get(id)).filter((p): p is NotionPage => !!p),
    );
  }
}

describe("NotionTracker.fetchCandidateIssues (FR-TR-1, FR-TR-4)", () => {
  it("returns only issues whose Status is in active_states", async () => {
    const transport = new MockTransport([
      {
        pages: [
          statusPage("a", "Todo"),
          statusPage("b", "Done"), // terminal — excluded
          statusPage("c", "In Progress"),
        ],
        next_cursor: null,
        has_more: false,
      },
    ]);
    const { logger } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport, logger });

    const issues = await tracker.fetchCandidateIssues();
    expect(issues.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("matches active states case-insensitively", async () => {
    const transport = new MockTransport([
      {
        pages: [statusPage("a", "TODO"), statusPage("b", "in progress")],
        next_cursor: null,
        has_more: false,
      },
    ]);
    const { logger } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport, logger });
    const issues = await tracker.fetchCandidateIssues();
    expect(issues.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("paginates and preserves order across pages", async () => {
    const transport = new MockTransport([
      {
        pages: [statusPage("p1", "Todo"), statusPage("p2", "Todo")],
        next_cursor: "cursor-2",
        has_more: true,
      },
      {
        pages: [statusPage("p3", "Todo"), statusPage("p4", "Todo")],
        next_cursor: null,
        has_more: false,
      },
    ]);
    const { logger } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport, logger });

    const issues = await tracker.fetchCandidateIssues();
    expect(issues.map((i) => i.id)).toEqual(["p1", "p2", "p3", "p4"]);
    // Second query passed the cursor from the first page.
    expect(transport.queryCalls.map((c) => c.startCursor)).toEqual([null, "cursor-2"]);
  });

  it("skips malformed pages without failing the whole fetch", async () => {
    const transport = new MockTransport([
      {
        pages: [
          statusPage("a", "Todo"),
          { id: undefined, properties: {} } as NotionPage, // no id -> skipped
        ],
        next_cursor: null,
        has_more: false,
      },
    ]);
    const { logger, sink } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport, logger });
    const issues = await tracker.fetchCandidateIssues();
    expect(issues.map((i) => i.id)).toEqual(["a"]);
    expect(sink.records.some((r) => r.event === "tracker_page_skipped")).toBe(true);
  });
});

describe("NotionTracker candidate error → skip_tick (FR-TR-5)", () => {
  it("fetchCandidates surfaces a skip_tick signal, never throwing", async () => {
    const transport = new MockTransport([]);
    transport.queryError = new Error("mcp boom");
    const { logger, sink } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport, logger });

    const result = await tracker.fetchCandidates();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.signal).toBe("skip_tick");
      expect(result.category).toBe("notion_mcp_request");
    }
    expect(sink.records.some((r) => r.event === "tracker_candidate_fetch_failed")).toBe(true);
  });

  it("fetchCandidateIssues returns [] on failure (skip-tick at the boundary)", async () => {
    const transport = new MockTransport([]);
    transport.queryError = new Error("mcp boom");
    const { logger } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport, logger });
    await expect(tracker.fetchCandidateIssues()).resolves.toEqual([]);
  });

  it("maps missing api_key to missing_tracker_api_key", async () => {
    const transport = new MockTransport([]);
    const { logger } = makeLogger();
    const tracker = new NotionTracker({
      config: trackerConfig({ api_key: null }),
      transport,
      logger,
    });
    const result = await tracker.fetchCandidates();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("missing_tracker_api_key");
  });

  it("maps missing database to missing_tracker_database", async () => {
    const transport = new MockTransport([]);
    const { logger } = makeLogger();
    const tracker = new NotionTracker({
      config: trackerConfig({ database: null }),
      transport,
      logger,
    });
    const result = await tracker.fetchCandidates();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("missing_tracker_database");
  });

  it("maps non-notion kind to unsupported_tracker_kind", async () => {
    const transport = new MockTransport([]);
    const { logger } = makeLogger();
    const tracker = new NotionTracker({
      config: trackerConfig({ kind: "linear" }),
      transport,
      logger,
    });
    const result = await tracker.fetchCandidates();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("unsupported_tracker_kind");
  });

  it("flags a pagination integrity error when has_more lacks a cursor", async () => {
    const transport = new MockTransport([
      { pages: [statusPage("a", "Todo")], next_cursor: null, has_more: true },
    ]);
    const { logger } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport, logger });
    const result = await tracker.fetchCandidates();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("notion_mcp_pagination");
  });
});

describe("NotionTracker.fetchIssueStatesByIds (FR-TR-1)", () => {
  it("returns state refs for the ids that resolve", async () => {
    const transport = new MockTransport([], {
      a: statusPage("a", "Done"),
      b: statusPage("b", "In Progress"),
    });
    const { logger } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport, logger });

    const states = await tracker.fetchIssueStatesByIds(["a", "b", "missing"]);
    expect(states).toEqual([
      { id: "a", identifier: "A", state: "Done" },
      { id: "b", identifier: "B", state: "In Progress" },
    ]);
  });

  it("returns [] for an empty id list without calling the transport", async () => {
    const transport = new MockTransport([], {});
    const { logger } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport, logger });
    await expect(tracker.fetchIssueStatesByIds([])).resolves.toEqual([]);
    expect(transport.fetchCalls.length).toBe(0);
  });

  it("refresh error surfaces a keep_workers signal, never throwing", async () => {
    const transport = new MockTransport([], {});
    transport.fetchError = new Error("refresh boom");
    const { logger, sink } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport, logger });

    const result = await tracker.refreshStates(["a"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.signal).toBe("keep_workers");
    }
    await expect(tracker.fetchIssueStatesByIds(["a"])).resolves.toEqual([]);
    expect(sink.records.some((r) => r.event === "tracker_state_refresh_failed")).toBe(true);
  });
});

describe("read-only boundary (FR-TR-6)", () => {
  it("the transport interface used by the tracker exposes no write/mutation method", () => {
    // The MockTransport implements the full NotionMcpTransport contract; if a
    // write op existed on the interface this object would need to provide it.
    const transport = new MockTransport([]);
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(transport));
    // Only read operations are part of the contract.
    expect(keys).toContain("queryDatabase");
    expect(keys).toContain("fetchPagesByIds");
    const mutating = keys.filter((k) =>
      /create|update|delete|write|patch|set|move|archive/i.test(k),
    );
    expect(mutating).toEqual([]);
  });

  it("the tracker never invokes a mutation on the transport during a poll", async () => {
    // Wrap the transport in a Proxy that throws on any non-read access.
    const inner = new MockTransport([
      { pages: [statusPage("a", "Todo")], next_cursor: null, has_more: false },
    ]);
    // Only the two read methods may be *invoked* by the tracker; the guard
    // throws if any mutating-looking method name is invoked through the proxy.
    const guarded = new Proxy(inner, {
      get(target, prop, recv) {
        if (
          typeof prop === "string" &&
          /create|update|delete|write|patch|archive|move/i.test(prop)
        ) {
          throw new Error(`unexpected mutating transport access: ${prop}`);
        }
        return Reflect.get(target, prop, recv);
      },
    }) as unknown as NotionMcpTransport;
    const { logger } = makeLogger();
    const tracker = new NotionTracker({ config: trackerConfig(), transport: guarded, logger });
    await expect(tracker.fetchCandidateIssues()).resolves.toHaveLength(1);
  });
});
