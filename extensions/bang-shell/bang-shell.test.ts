import assert from "node:assert/strict";
import { test } from "node:test";
import { formatForModel, isShellMode, parseBang } from "./index.ts";

test("shell mode lights up on a bare bang, before any command exists", () => {
  // The tint has to appear the moment `!` is typed; parseBang deliberately
  // rejects the empty command, so the two predicates cannot be the same one.
  assert.equal(isShellMode("!"), true);
  assert.equal(parseBang("!"), undefined);
  assert.equal(isShellMode("!git status"), true);
  assert.equal(isShellMode("explain !"), false);
  assert.equal(isShellMode(""), false);
});

test("parses a bang command and strips surrounding space", () => {
  assert.equal(parseBang("!ls -la"), "ls -la");
  assert.equal(parseBang("!  git status  "), "git status");
});

test("a bare bang is not a command", () => {
  // Otherwise typing `!` and hesitating would spawn an empty shell.
  assert.equal(parseBang("!"), undefined);
  assert.equal(parseBang("!   "), undefined);
});

test("text that merely contains a bang is left to the model", () => {
  assert.equal(parseBang("wow!"), undefined);
  assert.equal(parseBang("what does !x mean in bash"), undefined);
});

test("the model transcript says who ran the command", () => {
  // Without this the model reads the output as its own tool result and starts
  // reasoning about a command it never issued.
  const text = formatForModel({
    command: "git status",
    cwd: "/repo",
    code: 0,
    output: "nothing to commit",
  });
  assert.match(text, /The user ran a shell command in \/repo/);
  assert.match(text, /\$ git status/);
  assert.match(text, /nothing to commit/);
  assert.doesNotMatch(text, /exit/);
});

test("failure and timeout are reported, success is not annotated", () => {
  const failed = formatForModel({
    command: "false",
    cwd: "/repo",
    code: 1,
    output: "",
  });
  assert.match(failed, /\[exit 1\]/);
  assert.match(failed, /\(no output\)/);

  const killed = formatForModel({
    command: "sleep 999",
    cwd: "/repo",
    code: null,
    killed: true,
    output: "",
  });
  assert.match(killed, /\[killed: exceeded 120s\]/);
  // A killed command must not also claim an exit code.
  assert.doesNotMatch(killed, /\[exit/);
});

test("oversized output is truncated for the model", () => {
  const text = formatForModel({
    command: "yes",
    cwd: "/repo",
    code: 0,
    output: "x".repeat(64 * 1024),
  });
  assert.match(text, /\[output truncated\]/);
  assert.ok(text.length < 32 * 1024, "context payload stays bounded");
});
