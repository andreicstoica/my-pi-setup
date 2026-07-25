import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatChangeStat,
  parseUnifiedDiff,
  summarizePaths,
} from "./src/diff.ts";

// Real `git show` output shape, trimmed. Includes the preamble the parser must
// skip and a hunk header it must turn into a line number.
const SHOW = `commit b3d574caa73f7014de0c7d6ba056335281b1195d
Author: Someone <a@b.c>

    [Notebook] flip the enum

diff --git a/frontend/app/src/router.tsx b/frontend/app/src/router.tsx
index 29a4149f0..1fed392c9 100644
--- a/frontend/app/src/router.tsx
+++ b/frontend/app/src/router.tsx
@@ -232,15 +231,15 @@ const redirectRoutes: RouteObject[] = [
   },
   {
-    path: '/my-network',
-    element: <RedirectWithParams to='/network' />
+    path: NOTEBOOK_BASE_PATH,
+    element: <RedirectWithParams to='/notebook' />
   },
`;

test("parses a real git show payload", () => {
  const files = parseUnifiedDiff(SHOW);
  assert.equal(files.length, 1);
  const file = files[0]!;
  assert.equal(file.path, "frontend/app/src/router.tsx");
  assert.equal(file.added, 2);
  assert.equal(file.removed, 2);
  assert.equal(file.hunks.length, 1);
  // The hunk header's +231 is what makes the diff navigable.
  assert.equal(file.hunks[0]!.startLine, 231);
});

test("skips the commit preamble and index/+++/--- noise", () => {
  const texts = parseUnifiedDiff(SHOW).flatMap((f) =>
    f.hunks.flatMap((h) => h.lines.map((l) => l.text)),
  );
  assert.ok(!texts.some((t) => t.startsWith("index ")));
  assert.ok(!texts.some((t) => t.includes("Author:")));
  assert.ok(!texts.some((t) => t.startsWith("++ ") || t.startsWith("-- ")));
});

test("tracks new-file line numbers across context and additions", () => {
  const lines = parseUnifiedDiff(SHOW)[0]!.hunks[0]!.lines;
  const context = lines.filter((l) => l.kind === "context");
  // First context line sits at the hunk start.
  assert.equal(context[0]?.newLine, 231);
  // Removed lines have no new-file position.
  assert.ok(
    lines
      .filter((l) => l.kind === "removed")
      .every((l) => l.newLine === undefined),
  );
});

test("handles multiple files", () => {
  const two = `diff --git a/a.ts b/a.ts
@@ -1,2 +1,3 @@
 keep
+added
diff --git a/b.py b/b.py
@@ -10,1 +10,1 @@
-gone
`;
  const files = parseUnifiedDiff(two);
  assert.deepEqual(
    files.map((f) => f.path),
    ["a.ts", "b.py"],
  );
  assert.equal(files[0]!.added, 1);
  assert.equal(files[1]!.removed, 1);
  assert.equal(formatChangeStat(files), "+1 -1");
});

test("detects renames and binaries", () => {
  const renamed = `diff --git a/old/path.ts b/new/path.ts
similarity index 95%
rename from old/path.ts
rename to new/path.ts
@@ -1,1 +1,1 @@
-a
+b
`;
  const [file] = parseUnifiedDiff(renamed);
  assert.equal(file!.path, "new/path.ts");
  assert.equal(file!.oldPath, "old/path.ts");

  const binary = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;
  const [bin] = parseUnifiedDiff(binary);
  assert.equal(bin!.binary, true);
  assert.equal(formatChangeStat([bin!]), "binary");
});

test("empty input yields no files rather than throwing", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.equal(formatChangeStat([]), "no changes");
});

test("summarizePaths caps the collapsed header", () => {
  const files = ["a/one.ts", "b/two.ts", "c/three.ts", "d/four.ts"].map(
    (path) => ({
      path,
      hunks: [],
      added: 0,
      removed: 0,
    }),
  );
  assert.equal(summarizePaths(files.slice(0, 1)), "one.ts");
  assert.equal(summarizePaths(files.slice(0, 2)), "one.ts, two.ts");
  assert.equal(summarizePaths(files), "one.ts, two.ts +2 more");
});
