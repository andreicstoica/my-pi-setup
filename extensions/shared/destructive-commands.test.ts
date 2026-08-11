import assert from "node:assert/strict";
import { test } from "node:test";
import {
  basename,
  findDestructiveCommand,
  tokenizeSegment,
} from "./destructive-commands.ts";

// --- tokenizer ------------------------------------------------------------

test("peels env assignments and passthrough wrappers", () => {
  assert.deepEqual(tokenizeSegment("  PGPASSWORD=x sudo psql -c 'SELECT 1'"), [
    "psql",
    "-c",
    "'SELECT",
    "1'",
  ]);
  assert.deepEqual(tokenizeSegment("   "), []);
  assert.deepEqual(tokenizeSegment("FOO=1 BAR=2"), []);
});

test("basename matches the executable, not a lookalike", () => {
  assert.equal(basename("/usr/local/bin/aws"), "aws");
  assert.equal(basename("'dropdb'"), "dropdb");
  assert.equal(basename("awslogs"), "awslogs");
});

// --- destructive detection ------------------------------------------------

test("flags database destruction", () => {
  assert.match(findDestructiveCommand("dropdb liftoff") ?? "", /dropdb/);
  assert.match(
    findDestructiveCommand('psql -c "DROP DATABASE liftoff"') ?? "",
    /DROP DATABASE/,
  );
  assert.match(
    findDestructiveCommand('psql -c "TRUNCATE users"') ?? "",
    /TRUNCATE/,
  );
  assert.match(
    findDestructiveCommand('psql -c "DELETE FROM users"') ?? "",
    /WHERE/,
  );
});

test("a scoped psql DELETE is allowed", () => {
  assert.equal(
    findDestructiveCommand('psql -c "DELETE FROM users WHERE id = 1"'),
    undefined,
  );
});

test("prose mentioning DROP TABLE is not a match", () => {
  assert.equal(
    findDestructiveCommand('git commit -m "drop table users migration"'),
    undefined,
  );
});

test("flags a force push to trunk only", () => {
  assert.match(
    findDestructiveCommand("git push --force origin master") ?? "",
    /force push/,
  );
  assert.equal(
    findDestructiveCommand("git push --force origin my-branch"),
    undefined,
  );
  assert.equal(findDestructiveCommand("git push origin master"), undefined);
});

test("flags recursive rm aimed outside the working tree", () => {
  assert.match(findDestructiveCommand("rm -rf ~") ?? "", /recursive rm/);
  assert.match(findDestructiveCommand("rm -rf $HOME") ?? "", /recursive rm/);
  assert.match(findDestructiveCommand("rm -rf ../other") ?? "", /recursive rm/);
  assert.equal(findDestructiveCommand("rm -rf node_modules"), undefined);
});

test("inspects every segment, not just the first command", () => {
  assert.match(
    findDestructiveCommand("echo hi && dropdb liftoff") ?? "",
    /dropdb/,
  );
  assert.match(findDestructiveCommand("(sudo dropdb liftoff)") ?? "", /dropdb/);
});

test("a harmless command is not flagged", () => {
  assert.equal(findDestructiveCommand("ls -la && git status"), undefined);
});
