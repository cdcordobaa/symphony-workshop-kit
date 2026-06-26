import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolvePath, resolveVar } from "../resolve.js";

describe("resolveVar", () => {
  it("resolves a whole-value $VAR reference", () => {
    expect(resolveVar("$FOO", { FOO: "bar" })).toBe("bar");
    expect(resolveVar("${FOO}", { FOO: "bar" })).toBe("bar");
  });
  it("resolves an undefined $VAR to empty string (⇒ treated as missing)", () => {
    expect(resolveVar("$MISSING", {})).toBe("");
  });
  it("leaves non-$VAR strings untouched", () => {
    expect(resolveVar("literal-token", { literal: "x" })).toBe("literal-token");
    expect(resolveVar("https://api.example.com", {})).toBe(
      "https://api.example.com",
    );
  });
  it("does not partially expand embedded $VAR (only whole-value refs)", () => {
    expect(resolveVar("prefix-$FOO", { FOO: "bar" })).toBe("prefix-$FOO");
  });
});

describe("resolvePath", () => {
  it("expands ~ to home", () => {
    expect(resolvePath("~", "/base", {})).toBe(path.normalize(os.homedir()));
    expect(resolvePath("~/x/y", "/base", {})).toBe(
      path.join(os.homedir(), "x/y"),
    );
  });
  it("resolves relative paths against the WORKFLOW.md dir", () => {
    expect(resolvePath("./ws", "/base/dir", {})).toBe("/base/dir/ws");
    expect(resolvePath("ws", "/base/dir", {})).toBe("/base/dir/ws");
  });
  it("keeps absolute paths absolute (normalized)", () => {
    expect(resolvePath("/abs/ws", "/base", {})).toBe("/abs/ws");
  });
  it("resolves a $VAR path then makes it absolute", () => {
    expect(resolvePath("$WS_ROOT", "/base", { WS_ROOT: "/var/ws" })).toBe(
      "/var/ws",
    );
    expect(resolvePath("$WS_REL", "/base", { WS_REL: "rel" })).toBe("/base/rel");
  });
});
