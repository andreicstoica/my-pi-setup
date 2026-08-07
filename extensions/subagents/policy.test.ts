import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyAwsInvocation,
  evaluateToolUse,
  findAwsInvocations,
  parseMcpToolName,
} from "./src/policy.ts";

const bash = (command: string) => evaluateToolUse("Bash", { command });

// --- MCP name parsing -----------------------------------------------------

test("parses mcp tool names and ignores non-mcp tools", () => {
  assert.deepEqual(parseMcpToolName("mcp__claude_ai_Sentry__search_issues"), {
    server: "claude_ai_Sentry",
    tool: "search_issues",
  });
  assert.equal(parseMcpToolName("Bash"), undefined);
  assert.equal(parseMcpToolName("Read"), undefined);
});

// --- Read-only MCP servers ------------------------------------------------

test("allows reads on read-only MCP servers", () => {
  for (const tool of [
    "mcp__claude_ai_Sentry__search_issues",
    "mcp__claude_ai_Sentry__search_events",
    "mcp__claude_ai_Sentry__find_projects",
    "mcp__claude_ai_Sentry__get_sentry_resource",
    "mcp__plugin_figma_figma__get_design_context",
    "mcp__plugin_figma_figma__get_screenshot",
    "mcp__plugin_figma_figma__get_variable_defs",
    "mcp__plugin_figma_figma__search_design_system",
  ]) {
    assert.equal(
      evaluateToolUse(tool, {}),
      undefined,
      `${tool} should be allowed`,
    );
  }
});

test("denies writes on read-only MCP servers", () => {
  for (const tool of [
    "mcp__claude_ai_Sentry__update_issue",
    "mcp__claude_ai_Sentry__execute_sentry_tool",
    "mcp__plugin_figma_figma__create_new_file",
    "mcp__plugin_figma_figma__upload_assets",
    "mcp__plugin_figma_figma__add_code_connect_map",
    "mcp__plugin_figma_figma__send_code_connect_mappings",
    "mcp__plugin_figma_figma__generate_figma_design",
  ]) {
    assert.ok(evaluateToolUse(tool, {}), `${tool} should be denied`);
  }
});

test("denies use_figma, whose name carries no write verb but runs arbitrary JS", () => {
  assert.ok(evaluateToolUse("mcp__plugin_figma_figma__use_figma", {}));
  assert.ok(evaluateToolUse("mcp__plugin_figma_figma__use_figjam", {}));
});

test("covers Linear write tools that are not enumerable while it is unauthenticated", () => {
  // Linear currently exposes only auth tools, so the policy has to work off
  // verb shape rather than a captured list.
  assert.ok(evaluateToolUse("mcp__claude_ai_Linear__create_issue", {}));
  assert.ok(evaluateToolUse("mcp__claude_ai_Linear__update_issue", {}));
  assert.ok(evaluateToolUse("mcp__claude_ai_Linear__create_comment", {}));
  assert.equal(
    evaluateToolUse("mcp__claude_ai_Linear__list_issues", {}),
    undefined,
  );
  assert.equal(
    evaluateToolUse("mcp__claude_ai_Linear__get_issue", {}),
    undefined,
  );
});

test("leaves MCP servers outside the read-only set untouched", () => {
  // The Liftoff prod MCP is already read-only server-side, and svelte/mobbin/
  // tldraw are not sensitive — policy must not silently break them.
  assert.equal(evaluateToolUse("mcp__liftoff__tool_get_schema", {}), undefined);
  assert.equal(evaluateToolUse("mcp__liftoff__execute_query", {}), undefined);
  assert.equal(evaluateToolUse("mcp__tldraw__create_shape", {}), undefined);
});

// --- aws parsing ----------------------------------------------------------

test("finds aws invocations behind shell operators and wrappers", () => {
  assert.deepEqual(findAwsInvocations("aws s3 ls"), [["s3", "ls"]]);
  assert.deepEqual(findAwsInvocations("ls && aws s3 rm s3://b/k"), [
    ["s3", "rm", "s3://b/k"],
  ]);
  assert.deepEqual(findAwsInvocations("AWS_PROFILE=prod aws s3 rm s3://b/k"), [
    ["s3", "rm", "s3://b/k"],
  ]);
  assert.deepEqual(
    findAwsInvocations("sudo aws ec2 terminate-instances --ids i-1"),
    [["ec2", "terminate-instances", "--ids", "i-1"]],
  );
  assert.deepEqual(findAwsInvocations("/usr/local/bin/aws s3 rm s3://b/k"), [
    ["s3", "rm", "s3://b/k"],
  ]);
  assert.deepEqual(findAwsInvocations("(aws s3 rm s3://b/k)"), [
    ["s3", "rm", "s3://b/k"],
  ]);
  assert.deepEqual(findAwsInvocations("echo hi | aws s3 cp - s3://b/k"), [
    ["s3", "cp", "-", "s3://b/k"],
  ]);
});

test("does not mistake other executables for aws", () => {
  assert.deepEqual(findAwsInvocations("awslogs get group"), []);
  assert.deepEqual(findAwsInvocations("./aws-helper deploy"), []);
  assert.deepEqual(findAwsInvocations("echo 'aws s3 rm'"), []);
  assert.deepEqual(findAwsInvocations("git commit -m 'use aws sdk'"), []);
});

test("classifies aws read operations as allowed", () => {
  for (const args of [
    ["s3", "ls"],
    ["s3api", "list-buckets"],
    ["ec2", "describe-instances"],
    ["logs", "tail", "/aws/lambda/f"],
    ["sts", "get-caller-identity"],
    ["dynamodb", "query", "--table-name", "t"],
    ["dynamodb", "scan", "--table-name", "t"],
    ["ssm", "get-parameter", "--name", "n"],
  ]) {
    assert.equal(
      classifyAwsInvocation(args),
      undefined,
      `aws ${args.join(" ")} should be allowed`,
    );
  }
});

test("classifies aws mutations as denied", () => {
  for (const args of [
    ["s3", "rm", "s3://b/k"],
    ["s3", "cp", "f", "s3://b/k"],
    ["s3", "sync", ".", "s3://b"],
    ["ec2", "terminate-instances"],
    ["ec2", "run-instances"],
    ["iam", "attach-role-policy"],
    ["lambda", "update-function-code"],
    ["rds", "delete-db-instance"],
    ["cloudformation", "deploy"],
  ]) {
    assert.ok(
      classifyAwsInvocation(args),
      `aws ${args.join(" ")} should be denied`,
    );
  }
});

test("unknown aws verbs are denied, not allowed by default", () => {
  // The point of the allow-list: a verb this parser has never seen must not
  // become permitted just because it is absent from a deny-list.
  assert.ok(classifyAwsInvocation(["newservice", "frobnicate"]));
});

test("bare or usage-only aws calls are allowed", () => {
  assert.equal(classifyAwsInvocation([]), undefined);
  assert.equal(classifyAwsInvocation(["--version"]), undefined);
  assert.equal(classifyAwsInvocation(["s3"]), undefined);
});

// --- end to end through evaluateToolUse ----------------------------------

test("Bash denials carry an actionable reason", () => {
  const denial = bash("aws s3 rm s3://liftoff-prod/data");
  assert.ok(denial);
  assert.match(denial, /not a read-only operation/);
  assert.match(denial, /surface the command for a human/);
});

test("ordinary Bash and code-writing tools are untouched", () => {
  // Subagents are explicitly meant to write code; policy must not interfere.
  assert.equal(bash("yarn lint && tsc --noEmit"), undefined);
  assert.equal(bash("git commit -am 'fix'"), undefined);
  assert.equal(bash("rm -rf node_modules"), undefined);
  assert.equal(evaluateToolUse("Write", { file_path: "a.ts" }), undefined);
  assert.equal(evaluateToolUse("Edit", { file_path: "a.ts" }), undefined);
});

test("a mutating aws call anywhere in a chain is caught", () => {
  assert.ok(bash("aws s3 ls && aws s3 rm s3://b/k"));
  assert.ok(
    bash("cd /tmp; AWS_PROFILE=prod aws ec2 terminate-instances --ids i-1"),
  );
});

test("non-string Bash input is ignored rather than throwing", () => {
  assert.equal(evaluateToolUse("Bash", {}), undefined);
  assert.equal(evaluateToolUse("Bash", { command: 42 }), undefined);
  assert.equal(evaluateToolUse("Bash", null), undefined);
});

// --- destructive shell commands -------------------------------------------

test("database destruction is blocked", () => {
  assert.ok(bash("dropdb liftoff"));
  assert.ok(bash("createdb tmp && dropdb tmp"));
  assert.ok(bash(`psql -c "DROP DATABASE liftoff"`));
  assert.ok(bash(`psql liftoff -c "drop table contacts"`));
  assert.ok(bash(`psql liftoff -c "TRUNCATE contacts"`));
  assert.ok(bash(`psql liftoff -c "DELETE FROM contacts;"`));
});

test("scoped SQL and prose mentioning DROP are allowed", () => {
  assert.equal(
    bash(`psql liftoff -c "DELETE FROM contacts WHERE id = 5"`),
    undefined,
  );
  assert.equal(bash(`psql liftoff -c "SELECT count(*) FROM users"`), undefined);
  assert.equal(bash(`git commit -m "drop table support"`), undefined);
  assert.equal(bash(`echo "DROP DATABASE would be bad"`), undefined);
});

test("force pushes to trunk are blocked, feature-branch pushes allowed", () => {
  assert.ok(bash("git push --force origin master"));
  assert.ok(bash("git push -f origin main"));
  assert.ok(bash("git push --force origin HEAD:master"));
  assert.equal(
    bash("git push --force-with-lease origin my-feature"),
    undefined,
  );
  assert.equal(bash("git push origin master"), undefined);
});

test("recursive rm outside the working tree is blocked", () => {
  assert.ok(bash("rm -rf /"));
  assert.ok(bash("rm -rf ~"));
  assert.ok(bash("rm -rf ../other-project"));
  assert.equal(bash("rm -rf node_modules"), undefined);
  assert.equal(bash("rm -rf dist build"), undefined);
});
