import { describe, expect, it } from "vitest";
import { FALLBACK_PROMPT, renderPrompt } from "../render.js";
import { makeIssue } from "../../../test/helpers.js";
import { isSymphonyError } from "../../domain/errors.js";

describe("renderPrompt happy path", () => {
  it("renders issue fields and attempt", () => {
    const out = renderPrompt(
      "Issue {{ issue.identifier }}: {{ issue.title }} attempt={{ attempt }}",
      makeIssue(),
      null,
    );
    expect(out).toBe("Issue SYM-1: Bootstrap the orchestrator attempt=");
  });

  it("renders nested labels and blockers (preserved arrays/maps)", () => {
    const tmpl =
      "labels:{% for l in issue.labels %}[{{ l }}]{% endfor %} " +
      "blockers:{% for b in issue.blocked_by %}({{ b.identifier }}:{{ b.state }}){% endfor %}";
    const out = renderPrompt(tmpl, makeIssue(), null);
    expect(out).toBe("labels:[backend][mvp] blockers:(SYM-0:Done)");
  });

  it("branches on attempt", () => {
    const tmpl = "{% if attempt %}retry {{ attempt }}{% else %}first{% endif %}";
    expect(renderPrompt(tmpl, makeIssue(), null)).toBe("first");
    expect(renderPrompt(tmpl, makeIssue(), 2)).toBe("retry 2");
  });

  it("uses the fallback prompt when the body is empty", () => {
    expect(renderPrompt("   \n  ", makeIssue(), null)).toBe(FALLBACK_PROMPT);
  });
});

describe("renderPrompt strict failures", () => {
  it("fails rendering on an unknown variable", () => {
    try {
      renderPrompt("{{ unknown_var }}", makeIssue(), null);
      throw new Error("expected throw");
    } catch (err) {
      expect(isSymphonyError(err)).toBe(true);
      if (isSymphonyError(err)) expect(err.code).toBe("render_failed");
    }
  });

  it("fails rendering on an unknown nested variable", () => {
    expect(() =>
      renderPrompt("{{ issue.nope }}", makeIssue(), null),
    ).toThrowError();
  });

  it("fails rendering on an unknown filter", () => {
    try {
      renderPrompt("{{ issue.title | no_such_filter }}", makeIssue(), null);
      throw new Error("expected throw");
    } catch (err) {
      expect(isSymphonyError(err)).toBe(true);
      if (isSymphonyError(err)) expect(err.code).toBe("render_failed");
    }
  });
});
