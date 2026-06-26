import { describe, expect, it } from "vitest";
import {
  coercePriority,
  DEFAULT_PROPERTY_MAP,
  normalizePage,
  parseTimestamp,
  type NotionPage,
} from "../normalize.js";

/** A representative Notion page using the default property names. */
function page(overrides: Partial<NotionPage> = {}): NotionPage {
  return {
    id: "page_1",
    url: "https://notion.so/page_1",
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-02T12:30:00.000Z",
    properties: {
      Name: { title: [{ plain_text: "Implement tracker" }] },
      Status: { status: { name: "In Progress" } },
      Priority: { number: 2 },
      Labels: { multi_select: [{ name: "Backend" }, { name: "MVP" }] },
      "Blocked by": {
        relation: [{ id: "page_0", identifier: "SYM-0", state: "Done" }],
      },
      ID: { rich_text: [{ plain_text: "SYM-3" }] },
      Description: { rich_text: [{ plain_text: "Read-only Notion adapter." }] },
    },
    ...overrides,
  };
}

describe("normalizePage (§4.1.1, §11.3, FR-TR-3)", () => {
  it("maps core fields into the Issue model", () => {
    const issue = normalizePage(page())!;
    expect(issue).not.toBeNull();
    expect(issue.id).toBe("page_1");
    expect(issue.identifier).toBe("SYM-3");
    expect(issue.title).toBe("Implement tracker");
    expect(issue.description).toBe("Read-only Notion adapter.");
    expect(issue.state).toBe("In Progress");
    expect(issue.url).toBe("https://notion.so/page_1");
  });

  it("lowercases labels", () => {
    const issue = normalizePage(page())!;
    expect(issue.labels).toEqual(["backend", "mvp"]);
  });

  it("coerces priority to integer-or-null", () => {
    expect(normalizePage(page())!.priority).toBe(2);
    expect(
      normalizePage(
        page({ properties: { ...page().properties, Priority: { number: 1.5 } } }),
      )!.priority,
    ).toBeNull();
    expect(
      normalizePage(
        page({ properties: { ...page().properties, Priority: { number: null } } }),
      )!.priority,
    ).toBeNull();
  });

  it("parses ISO-8601 timestamps and nulls invalid ones", () => {
    const issue = normalizePage(page())!;
    expect(issue.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(issue.updated_at).toBe("2026-01-02T12:30:00.000Z");
    const bad = normalizePage(
      page({ created_time: "not-a-date", last_edited_time: 12345 }),
    )!;
    expect(bad.created_at).toBeNull();
    expect(bad.updated_at).toBeNull();
  });

  it("populates blocked_by from the relation property", () => {
    const issue = normalizePage(page())!;
    expect(issue.blocked_by).toEqual([
      { id: "page_0", identifier: "SYM-0", state: "Done" },
    ]);
  });

  it("handles bare page-id blocker relations", () => {
    const issue = normalizePage(
      page({
        properties: {
          ...page().properties,
          "Blocked by": { relation: [{ id: "page_x" }] },
        },
      }),
    )!;
    expect(issue.blocked_by).toEqual([
      { id: "page_x", identifier: null, state: null },
    ]);
  });

  it("returns null when the page has no id", () => {
    expect(normalizePage(page({ id: undefined }))).toBeNull();
  });

  it("returns null when the page has no Status", () => {
    const p = page();
    delete (p.properties as Record<string, unknown>).Status;
    expect(normalizePage(p)).toBeNull();
  });

  it("falls back to the page id when no identifier property is present", () => {
    const p = page();
    delete (p.properties as Record<string, unknown>).ID;
    const issue = normalizePage(p)!;
    expect(issue.identifier).toBe("page_1");
  });

  it("supports a custom property map", () => {
    const custom = normalizePage(
      {
        id: "p2",
        properties: {
          Titre: { title: [{ plain_text: "Bonjour" }] },
          Etat: { select: { name: "Todo" } },
        },
      },
      { ...DEFAULT_PROPERTY_MAP, title: "Titre", status: "Etat" },
    )!;
    expect(custom.title).toBe("Bonjour");
    expect(custom.state).toBe("Todo");
  });
});

describe("parseTimestamp / coercePriority helpers", () => {
  it("parseTimestamp normalizes to ISO", () => {
    expect(parseTimestamp("2026-06-02")).toBe("2026-06-02T00:00:00.000Z");
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp(42)).toBeNull();
  });

  it("coercePriority rejects non-integers", () => {
    expect(coercePriority(3)).toBe(3);
    expect(coercePriority("4")).toBe(4);
    expect(coercePriority("high")).toBeNull();
    expect(coercePriority("2.5")).toBeNull();
    expect(coercePriority(2.5)).toBeNull();
    expect(coercePriority(null)).toBeNull();
  });
});
