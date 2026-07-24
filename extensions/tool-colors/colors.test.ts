import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { classify, colorFor, shouldRemap } from "./src/colors.ts";

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

test("classifies the built-in tool titles pi actually renders", () => {
  // Titles taken from dist/core/tools/*.js renderCall implementations.
  assert.equal(classify("$ npm run check"), "shell");
  assert.equal(classify("read src/index.ts"), "read");
  assert.equal(classify("read image"), "read");
  assert.equal(classify("ls ."), "read");
  assert.equal(classify("find *.ts"), "read");
  assert.equal(classify("grep TODO"), "read");
  assert.equal(classify("write src/new.ts"), "mutate");
  assert.equal(classify("edit src/index.ts"), "mutate");
});

test("classifies extension tools", () => {
  assert.equal(classify("subagent_spawn"), "remote");
  assert.equal(classify("firecrawl_search"), "remote");
  assert.equal(classify("fd **/*.json"), "read");
  assert.equal(classify("rg pattern"), "read");
});

test("leaves unrecognised titles on the default token", () => {
  assert.equal(classify("todo_write"), undefined);
  assert.equal(colorFor("todo_write"), "toolTitle");
  assert.equal(shouldRemap("toolTitle", "todo_write"), undefined);
});

test("sees through bold and colour wrappers", () => {
  // pi wraps titles in theme.bold() before fg(), so the raw text carries ANSI.
  assert.equal(classify(`${BOLD}edit${RESET} src/index.ts`), "mutate");
  assert.equal(colorFor(`${BOLD}$ ls${RESET}`), "success");
});

test("read-only, mutating, shell and remote tools get four distinct tokens", () => {
  const tokens = new Set([
    colorFor("read a.ts"),
    colorFor("write a.ts"),
    colorFor("$ ls"),
    colorFor("subagent_spawn"),
  ]);
  assert.equal(tokens.size, 4);
});

test("shouldRemap only ever fires for toolTitle", () => {
  assert.equal(shouldRemap("toolTitle", "edit a.ts"), "warning");
  assert.equal(shouldRemap("toolOutput", "edit a.ts"), undefined);
  assert.equal(shouldRemap("error", "$ ls"), undefined);
});

// --- The seam itself ------------------------------------------------------
// These assert against the real exported Theme class, which is what the
// prototype patch in ../index.ts actually mutates. A Proxy-on-instance
// approach could not be covered this way.

test("pi still exports Theme with fg on the prototype", () => {
  assert.equal(typeof Theme, "function");
  assert.equal(typeof Theme.prototype.fg, "function");
});

/** Mirrors patchThemePrototype() in ../index.ts, returning an undo function. */
function patchForTest() {
  const original = Theme.prototype.fg;
  Theme.prototype.fg = function (this: Theme, color: string, text: string) {
    const mapped = shouldRemap(color, text);
    if (mapped) {
      try {
        return (original as (c: string, t: string) => string).call(
          this,
          mapped,
          text,
        );
      } catch {
        /* fall through */
      }
    }
    return (original as (c: string, t: string) => string).call(
      this,
      color,
      text,
    );
  } as typeof Theme.prototype.fg;
  return () => {
    Theme.prototype.fg = original;
  };
}

/**
 * Theme's constructor walks `Object.entries(fgColors)`, so the fixture has to
 * carry every token pi might ask for. The token list is read from the theme
 * that ships with this repo so the fixture can't drift from pi's real schema.
 */
function makeTheme() {
  const shipped = JSON.parse(
    readFileSync(
      new URL("../../themes/github-dark-default.json", import.meta.url),
      "utf8",
    ),
  ) as { colors: Record<string, string> };

  const fg: Record<string, string> = {};
  for (const token of Object.keys(shipped.colors)) fg[token] = "#999999";
  // Distinct, recognisable values for the tokens the mapping targets.
  Object.assign(fg, {
    toolTitle: "#111111",
    success: "#222222",
    mdLink: "#333333",
    warning: "#444444",
    mdCode: "#555555",
    toolOutput: "#666666",
    error: "#777777",
  });

  const bg: Record<string, string> = {
    selectedBg: "#000000",
    userMessageBg: "#000000",
    customMessageBg: "#000000",
    toolPendingBg: "#000000",
    toolSuccessBg: "#000000",
    toolErrorBg: "#000000",
  };

  return new Theme(fg as never, bg as never, "truecolor", { name: "test" });
}

test("patched Theme.prototype.fg renders four distinct colours for four tool kinds", () => {
  const undo = patchForTest();
  try {
    const theme = makeTheme();
    const rendered = [
      theme.fg("toolTitle", "read a.ts"),
      theme.fg("toolTitle", "write a.ts"),
      theme.fg("toolTitle", "$ ls"),
      theme.fg("toolTitle", "subagent_spawn"),
    ];
    assert.equal(
      new Set(rendered).size,
      4,
      `expected 4 distinct renders, got ${rendered}`,
    );
    // An unmapped title keeps the plain toolTitle colour.
    const plain = theme.fg("toolTitle", "todo_write");
    const other = theme.fg("toolOutput", "todo_write");
    assert.notEqual(plain, other);
  } finally {
    undo();
  }
});

test("patching does not disturb non-toolTitle colours", () => {
  const theme = makeTheme();
  const before = theme.fg("error", "boom");
  const undo = patchForTest();
  try {
    assert.equal(theme.fg("error", "boom"), before);
  } finally {
    undo();
  }
});

test("the patch applies to instances created after it, not just existing ones", () => {
  const undo = patchForTest();
  try {
    // This is the property the previous Proxy-per-instance approach lacked:
    // a theme built later (a /settings switch, a hot reload, an auto-theme
    // resync) is still covered.
    const fresh = makeTheme();
    assert.notEqual(
      fresh.fg("toolTitle", "$ ls"),
      fresh.fg("toolTitle", "read a.ts"),
    );
  } finally {
    undo();
  }
});
