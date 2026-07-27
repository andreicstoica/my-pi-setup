import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendToSection,
  buildMemoryPrompt,
  parseSections,
  tailEntries,
} from "./index.ts";

const FILE = `# Memory

blurb

## Pinned

- 2026-01-01 — never do X

## Log

- 2026-01-02 — first
- 2026-01-03 — second
`;

test("splits the two zones and ignores the preamble", () => {
  const { pinned, log } = parseSections(FILE);
  assert.equal(pinned, "- 2026-01-01 — never do X");
  assert.equal(log, "- 2026-01-02 — first\n- 2026-01-03 — second");
});

test("a file missing a heading reads as empty, not as an error", () => {
  // Older files, or one the user hand-edited down to nothing.
  assert.deepEqual(parseSections("# Memory\n\njust prose\n"), {
    pinned: "",
    log: "",
  });
});

test("the window keeps the NEWEST whole entries", () => {
  const log = ["- a", "- b", "- c"].join("\n");
  // Budget fits two entries plus newlines, so the oldest must drop.
  assert.equal(tailEntries(log, 8), "- b\n- c");
});

test("the window never cuts an entry in half", () => {
  const log = "- short\n- " + "x".repeat(200);
  const out = tailEntries(log, 50);
  // One oversized entry beats returning nothing, but it is returned whole.
  assert.equal(out, "- " + "x".repeat(200));
});

test("multi-line entries stay attached to their bullet", () => {
  const log = "- one\n  continued\n- two";
  assert.equal(tailEntries(log, 1024), "- one\n  continued\n- two");
});

test("pinned facts survive a full log window", () => {
  // The whole point of two zones: a pure tail would evict the safety rail.
  const log = Array.from({ length: 400 }, (_, i) => `- entry ${i}`).join("\n");
  const prompt = buildMemoryPrompt(`## Pinned\n\n- never do X\n\n## Log\n\n${log}`);
  assert.ok(prompt);
  assert.match(prompt, /never do X/);
  assert.match(prompt, /entry 399/);
  assert.doesNotMatch(prompt, /entry 0\b/);
});

test("an empty memory file injects nothing", () => {
  // Otherwise every turn pays for a header announcing there are no memories.
  assert.equal(buildMemoryPrompt("# Memory\n\n## Pinned\n\n## Log\n"), undefined);
});

test("the prompt tells the model the window is partial", () => {
  const prompt = buildMemoryPrompt(FILE);
  assert.ok(prompt);
  assert.match(prompt, /grep it before assuming/);
});

test("appending lands inside the right section", () => {
  const next = appendToSection(FILE, "pinned", "- 2026-02-02 — pinned late");
  const { pinned, log } = parseSections(next);
  assert.match(pinned, /pinned late$/);
  assert.doesNotMatch(log, /pinned late/);
  // The log keeps its order and its contents.
  assert.equal(log, "- 2026-01-02 — first\n- 2026-01-03 — second");
});

test("appending to the log puts the entry last", () => {
  const { log } = parseSections(appendToSection(FILE, "log", "- 2026-01-04 — third"));
  assert.equal(log.split("\n").at(-1), "- 2026-01-04 — third");
});

test("a missing section is created rather than dropping the entry", () => {
  const next = appendToSection("# Memory\n", "log", "- 2026-01-05 — first ever");
  assert.match(next, /## Log\n\n- 2026-01-05 — first ever/);
});
