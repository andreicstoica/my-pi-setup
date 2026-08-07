import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendToSection,
  buildMemoryPrompt,
  formatEntry,
  parseSections,
  queryTerms,
  renderRecall,
  repoSlug,
  scoreEntry,
  searchMemory,
  splitEntries,
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
  const prompt = buildMemoryPrompt({
    global: `## Pinned\n\n- never do X\n\n## Log\n\n${log}`,
  });
  assert.ok(prompt);
  assert.match(prompt, /never do X/);
  assert.match(prompt, /entry 399/);
  assert.doesNotMatch(prompt, /entry 0\b/);
});

test("an empty memory file injects nothing", () => {
  // Otherwise every turn pays for a header announcing there are no memories.
  assert.equal(
    buildMemoryPrompt({ global: "# Memory\n\n## Pinned\n\n## Log\n" }),
    undefined,
  );
});

test("the prompt tells the model the window is partial", () => {
  const prompt = buildMemoryPrompt({
    global: FILE,
    paths: { global: "/g.md" },
  });
  assert.ok(prompt);
  // The escape hatch must be named, or the model treats the tail as the whole.
  assert.match(prompt, /call `recall` before assuming/);
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
  const { log } = parseSections(
    appendToSection(FILE, "log", "- 2026-01-04 — third"),
  );
  assert.equal(log.split("\n").at(-1), "- 2026-01-04 — third");
});

test("a missing section is created rather than dropping the entry", () => {
  const next = appendToSection(
    "# Memory\n",
    "log",
    "- 2026-01-05 — first ever",
  );
  assert.match(next, /## Log\n\n- 2026-01-05 — first ever/);
});

test("every worktree of a repo maps to one project file", () => {
  // kit gives each feature its own worktree; a fact learned in one holds in all
  // of them, so the remote — not the checkout path — is the key.
  const master = repoSlug({
    remoteUrl: "https://github.com/liftoff-inc/liftoff-app.git",
    gitCommonDir: "/Users/acs/liftoff/liftoff-app-master/.git",
  });
  const worktree = repoSlug({
    remoteUrl: "https://github.com/liftoff-inc/liftoff-app.git",
    gitCommonDir: "/Users/acs/liftoff/liftoff-app-master/.git",
  });
  assert.equal(master, "liftoff-inc-liftoff-app");
  assert.equal(worktree, master);
  // SSH remotes name the same project as HTTPS ones.
  assert.equal(
    repoSlug({ remoteUrl: "git@github.com:liftoff-inc/liftoff-app.git" }),
    master,
  );
});

test("a repo with no remote still gets a stable key", () => {
  assert.equal(repoSlug({ gitCommonDir: "/Users/acs/code/kit/.git" }), "kit");
  assert.equal(repoSlug({}), undefined);
});

test("both scopes are labelled so the model knows where a fact came from", () => {
  const prompt = buildMemoryPrompt({
    global: "## Pinned\n\n- global rail\n\n## Log\n\n- g1",
    project: "## Pinned\n\n## Log\n\n- p1",
    projectLabel: "liftoff-inc-liftoff-app",
    paths: { global: "/g.md", project: "/p.md" },
  });
  assert.ok(prompt);
  assert.match(prompt, /## Global/);
  assert.match(prompt, /## Project — liftoff-inc-liftoff-app/);
  assert.match(prompt, /global rail/);
  assert.match(prompt, /- p1/);
  assert.match(prompt, /\/g\.md and \/p\.md/);
});

test("project-only memory renders without an empty global section", () => {
  const prompt = buildMemoryPrompt({
    project: "## Pinned\n\n## Log\n\n- p1",
    projectLabel: "kit",
  });
  assert.ok(prompt);
  assert.doesNotMatch(prompt, /## Global/);
  assert.match(prompt, /## Project — kit/);
});

test("an incoming fact cannot get double-stamped", () => {
  // Seen in the wild: a model that had read the file echoed its line format
  // back, producing `- 2026-07-27 — 2026-07-27 — …`.
  const day = new Date("2026-07-27T12:00:00Z");
  assert.equal(
    formatEntry("2026-07-27 — do not auto-push", day),
    "- 2026-07-27 — do not auto-push",
  );
  assert.equal(
    formatEntry("- 2026-07-27 — do not auto-push", day),
    "- 2026-07-27 — do not auto-push",
  );
  assert.equal(
    formatEntry("do not auto-push", day),
    "- 2026-07-27 — do not auto-push",
  );
});

test("a date INSIDE the fact is left alone", () => {
  // Only a leading stamp is stripped; "as of 2026-07" is content.
  const day = new Date("2026-07-27T12:00:00Z");
  assert.match(
    formatEntry("backend is uv as of 2026-07-01", day),
    /— backend is uv as of 2026-07-01$/,
  );
});

test("recall reaches an entry the injected window has scrolled past", () => {
  // The bug this tool exists for: without it, entry 0 is unreachable and the
  // model cannot tell it was ever recorded.
  const log = [
    "- 2026-01-01 — celery broker is shared across every worktree",
    ...Array.from({ length: 400 }, (_, i) => `- filler ${i}`),
  ].join("\n");
  const text = `## Pinned\n\n## Log\n\n${log}`;

  const prompt = buildMemoryPrompt({ global: text });
  assert.ok(prompt);
  assert.doesNotMatch(prompt, /celery broker/);

  const { hits } = searchMemory([{ label: "Global", text }], "celery broker");
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.entry, /celery broker/);
});

test("recall searches both zones and labels which is which", () => {
  const result = searchMemory(
    [
      {
        label: "Global",
        text: "## Pinned\n\n- never force-push to master\n\n## Log\n\n- master is the trunk branch",
      },
    ],
    "master",
  );
  assert.equal(result.hits.length, 2);
  assert.deepEqual(
    new Set(result.hits.map((hit) => hit.zone)),
    new Set(["Pinned", "Log"]),
  );
  assert.match(renderRecall(result, "master"), /\[pinned\]/);
});

test("matching every term beats matching one of them repeatedly", () => {
  // Otherwise a two-term lookup drowns in entries that spam a single term.
  const both = scoreEntry("- migration drop column", ["migration", "column"]);
  const one = scoreEntry("- migration migration migration", [
    "migration",
    "column",
  ]);
  assert.ok(both > one, `expected ${both} > ${one}`);
});

test("a whole-word hit outranks a substring hit", () => {
  assert.ok(
    scoreEntry("- the api is slow", ["api"]) >
      scoreEntry("- rapid growth", ["api"]),
  );
});

test("ties go to the newer entry", () => {
  // Memory has no contradiction handling, so the later wording is the one that
  // survived and must come first.
  const { hits } = searchMemory(
    [
      {
        label: "Global",
        text: "## Pinned\n\n## Log\n\n- 2026-01-01 — deploy is manual\n- 2026-06-01 — deploy is manual",
      },
    ],
    "deploy",
  );
  assert.match(hits[0]!.entry, /2026-06-01/);
});

test("recall says it searched everything when it finds nothing", () => {
  // "Not in the tail" and "never recorded" are different claims; only recall
  // can distinguish them, so the miss has to be explicit about which it is.
  const result = searchMemory(
    [{ label: "Global", text: "## Pinned\n\n## Log\n\n- 2026-01-01 — a fact" }],
    "kubernetes",
  );
  assert.equal(result.hits.length, 0);
  assert.match(renderRecall(result, "kubernetes"), /never recorded/);
});

test("an over-budget result set is capped out loud, not silently", () => {
  const log = Array.from(
    { length: 40 },
    (_, i) => `- 2026-01-01 — deploy note ${i}`,
  ).join("\n");
  const result = searchMemory(
    [{ label: "Global", text: `## Pinned\n\n## Log\n\n${log}` }],
    "deploy",
  );
  assert.equal(result.hits.length, 12);
  assert.equal(result.matched, 40);
  assert.match(
    renderRecall(result, "deploy"),
    /28 lower-scoring matches omitted/,
  );
});

test("a query with no usable terms asks for better terms", () => {
  assert.deepEqual(queryTerms("? !"), []);
  const result = searchMemory([{ label: "Global", text: FILE }], "?");
  assert.match(renderRecall(result, "?"), /No searchable terms/);
});

test("dates and paths survive tokenizing as single terms", () => {
  // These are exactly what a lookup keys on, so splitting them is a real miss.
  assert.deepEqual(queryTerms("2026-07-22 backend/api"), [
    "2026-07-22",
    "backend/api",
  ]);
});

test("multi-line entries are searched and returned whole", () => {
  const { hits } = searchMemory(
    [
      {
        label: "Global",
        text: "## Pinned\n\n## Log\n\n- one\n  continued with valkey\n- two",
      },
    ],
    "valkey",
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.entry, "- one\n  continued with valkey");
});

test("splitting an empty section yields no entries", () => {
  assert.deepEqual(splitEntries(""), []);
  assert.deepEqual(splitEntries("\n\n"), []);
});

test("a scope with no file is skipped rather than throwing", () => {
  // Outside a git repo the project scope has no path and no text.
  const result = searchMemory(
    [
      { label: "Global", text: "## Pinned\n\n## Log\n\n- 2026-01-01 — a fact" },
      { label: "Project", text: undefined },
    ],
    "fact",
  );
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.scope, "Global");
});
