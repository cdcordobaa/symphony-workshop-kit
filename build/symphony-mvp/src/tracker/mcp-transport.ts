/**
 * Concrete stdio Notion MCP transport (U2; FR-TR-2).
 *
 * Speaks JSON-RPC 2.0 over stdio to a spawned Notion MCP server process and maps
 * its tool responses into the `NotionMcpTransport` shape. Dependency-free: the
 * MVP avoids pulling a heavyweight MCP SDK so the build stays self-contained;
 * the JSON-RPC framing here is the minimal subset MCP requires
 * (`initialize` + `tools/call`).
 *
 * Auth (FR-TR-2): the configured Notion auth (already resolved from `$VAR` by
 * U1) is passed to the spawned server via its environment — no token is read
 * from disk here, and the transport exposes no write operation (read-only
 * boundary, FR-TR-6).
 *
 * This adapter is intentionally NOT exercised by unit tests (those use an
 * in-memory mock transport); it is the seam to a real Notion MCP server for
 * manual/integration runs. Notion MCP tool/response shapes drift, so response
 * parsing is defensive and the normalization layer tolerates loose JSON.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import type { NotionPage } from "./normalize.js";
import type {
  NotionMcpTransport,
  NotionQueryPage,
  NotionQueryParams,
} from "./transport.js";

/** Options to launch the Notion MCP server subprocess. */
export interface StdioNotionMcpOptions {
  /** Resolved Notion auth token (passed to the server via env). */
  apiKey: string;
  /** Command to launch the Notion MCP server. Default `npx`. */
  command?: string;
  /** Arguments for the launch command. */
  args?: string[];
  /**
   * Env var name the MCP server reads the token from. Default
   * `NOTION_API_KEY`. (Some servers use `NOTION_TOKEN`.)
   */
  tokenEnvVar?: string;
  /** Tool name for querying a data source/database. Default `query-database`. */
  queryToolName?: string;
  /** Tool name for fetching pages by id. Default `fetch`. */
  fetchToolName?: string;
  /** Per-request timeout (ms). Default `30000` (§11.2). */
  requestTimeoutMs?: number;
  /** Extra environment passed to the server. */
  env?: NodeJS.ProcessEnv;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Pull an array of page-like objects out of a loose MCP tool result. */
function extractPages(result: unknown): NotionPage[] {
  if (Array.isArray(result)) return result as NotionPage[];
  if (result && typeof result === "object") {
    const rec = result as Record<string, unknown>;
    for (const key of ["pages", "results", "items", "data"]) {
      if (Array.isArray(rec[key])) return rec[key] as NotionPage[];
    }
    // MCP tool results are often wrapped as { content: [{ type:'text', text }] }.
    if (Array.isArray(rec.content)) {
      for (const block of rec.content as Array<Record<string, unknown>>) {
        if (block && typeof block.text === "string") {
          try {
            return extractPages(JSON.parse(block.text));
          } catch {
            // fall through
          }
        }
      }
    }
  }
  return [];
}

function extractCursor(result: unknown): { next: string | null; more: boolean } {
  if (result && typeof result === "object") {
    const rec = result as Record<string, unknown>;
    const next =
      typeof rec.next_cursor === "string" ? rec.next_cursor : null;
    const more =
      typeof rec.has_more === "boolean" ? rec.has_more : next !== null;
    return { next, more };
  }
  return { next: null, more: false };
}

/**
 * Stdio JSON-RPC client for a Notion MCP server. Lazily spawns on first use.
 */
export class StdioNotionMcpTransport implements NotionMcpTransport {
  private readonly options: Required<
    Omit<StdioNotionMcpOptions, "env" | "args">
  > & { args: string[]; env: NodeJS.ProcessEnv };
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private initialized: Promise<void> | null = null;

  constructor(options: StdioNotionMcpOptions) {
    this.options = {
      apiKey: options.apiKey,
      command: options.command ?? "npx",
      args: options.args ?? ["-y", "@notionhq/notion-mcp-server"],
      tokenEnvVar: options.tokenEnvVar ?? "NOTION_API_KEY",
      queryToolName: options.queryToolName ?? "query-database",
      fetchToolName: options.fetchToolName ?? "fetch",
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      env: options.env ?? process.env,
    };
  }

  private ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      const env: NodeJS.ProcessEnv = {
        ...this.options.env,
        [this.options.tokenEnvVar]: this.options.apiKey,
      };
      const child = spawn(this.options.command, this.options.args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onData(chunk));
      child.on("exit", (code) => {
        const err = new Error(`notion mcp server exited (code=${String(code)})`);
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
        this.child = null;
        this.initialized = null;
      });
      await once(child, "spawn");
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "symphony-mvp", version: "0.1.0" },
      });
    })();
    return this.initialized;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) {
        waiter.reject(new Error(msg.error.message));
      } else {
        waiter.resolve(msg.result);
      }
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("notion mcp server not started"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`notion mcp request timed out: ${method}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(`${payload}\n`);
    });
  }

  private async callTool(name: string, args: unknown): Promise<unknown> {
    await this.ensureStarted();
    return this.request("tools/call", { name, arguments: args });
  }

  async queryDatabase(params: NotionQueryParams): Promise<NotionQueryPage> {
    const result = await this.callTool(this.options.queryToolName, {
      database_id: params.database,
      status_property: params.statusProperty,
      states: params.states,
      start_cursor: params.startCursor ?? undefined,
      page_size: params.pageSize,
    });
    const { next, more } = extractCursor(result);
    return {
      pages: extractPages(result),
      next_cursor: next,
      has_more: more,
    };
  }

  async fetchPagesByIds(ids: string[]): Promise<NotionPage[]> {
    const result = await this.callTool(this.options.fetchToolName, {
      page_ids: ids,
      ids,
    });
    return extractPages(result);
  }

  /** Terminate the spawned server (best-effort). */
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill();
    this.child = null;
    this.initialized = null;
  }
}
