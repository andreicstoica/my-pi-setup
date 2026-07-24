import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, colorFor, withToolColors } from "./src/colors.ts";

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

test("proxy only remaps toolTitle and leaves other colours alone", () => {
  const calls: Array<[string, string]> = [];
  const theme = {
    fg(color: string, text: string) {
      calls.push([color, text]);
      return text;
    },
    name: "stub",
  };

  const wrapped = withToolColors(theme);
  wrapped.fg("toolTitle", "edit src/index.ts");
  wrapped.fg("toolTitle", "$ ls");
  wrapped.fg("toolOutput", "some output");
  wrapped.fg("error", "boom");

  assert.deepEqual(calls, [
    ["warning", "edit src/index.ts"],
    ["success", "$ ls"],
    ["toolOutput", "some output"],
    ["error", "boom"],
  ]);
  // Non-fg members must pass through untouched.
  assert.equal(wrapped.name, "stub");
});

test("falls back to toolTitle when the mapped token is missing from the theme", () => {
  const theme = {
    fg(color: string, text: string) {
      if (color !== "toolTitle")
        throw new Error(`Unknown theme color: ${color}`);
      return `<${text}>`;
    },
  };

  assert.equal(
    withToolColors(theme).fg("toolTitle", "edit a.ts"),
    "<edit a.ts>",
  );
});
