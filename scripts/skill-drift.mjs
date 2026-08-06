/**
 * Skill-drift report: `.claude/skills` (Claude Code) vs `.agents/skills`
 * (pi, Codex, Cursor) in a repo that carries both trees.
 *
 * Reports, never enforces — some drift is deliberate and load-bearing
 * (`.agents/skills/ship` is harness-agnostic on purpose). But one missed
 * mirror (`review`'s Exposure Analysis section) silently degraded every
 * non-Claude review for weeks, so the drift needs to be *visible*: run this
 * after editing either tree and eyeball anything it lists.
 *
 * Frontmatter (`---` block) is ignored — the trees legitimately differ there.
 *
 * Usage: node skill-drift.mjs [repo-path]   (default: cwd)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repo = process.argv[2] ?? process.cwd();
const trees = {
  claude: join(repo, ".claude", "skills"),
  agents: join(repo, ".agents", "skills"),
};

function exists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

for (const [name, path] of Object.entries(trees)) {
  if (!exists(path)) {
    console.error(`no ${name} skill tree at ${path}`);
    process.exit(2);
  }
}

/** All files under a directory, as tree-relative paths. */
function filesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * File content with a leading `---` frontmatter block removed and tree-local
 * path references normalized: each tree correctly points at its own root
 * (`.claude/skills/...` vs `.agents/skills/...`), and that difference is not
 * drift.
 */
function body(path) {
  const text = readFileSync(path, "utf8");
  const match = text.match(/^---\n[\s\S]*?\n---\n?/);
  return (match ? text.slice(match[0].length) : text)
    .replaceAll(".claude/skills/", "<skills>/")
    .replaceAll(".agents/skills/", "<skills>/")
    .trim();
}

const skillDirs = (root) =>
  new Set(
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );

const claudeSkills = skillDirs(trees.claude);
const agentsSkills = skillDirs(trees.agents);

let findings = 0;
const report = (line) => {
  findings += 1;
  console.log(line);
};

for (const name of [...claudeSkills].filter((s) => !agentsSkills.has(s)).sort())
  report(`only in .claude:  ${name}/`);
for (const name of [...agentsSkills].filter((s) => !claudeSkills.has(s)).sort())
  report(`only in .agents:  ${name}/`);

for (const name of [...claudeSkills].filter((s) => agentsSkills.has(s)).sort()) {
  const a = join(trees.claude, name);
  const b = join(trees.agents, name);
  const filesA = filesUnder(a);
  const filesB = filesUnder(b);
  const setA = new Set(filesA);
  const setB = new Set(filesB);

  for (const file of filesA.filter((f) => !setB.has(f)))
    report(`${name}: file only in .claude:  ${file}`);
  for (const file of filesB.filter((f) => !setA.has(f)))
    report(`${name}: file only in .agents:  ${file}`);

  for (const file of filesA.filter((f) => setB.has(f))) {
    const bodyA = body(join(a, file));
    const bodyB = body(join(b, file));
    if (bodyA !== bodyB) {
      const linesA = bodyA.split("\n").length;
      const linesB = bodyB.split("\n").length;
      report(
        `${name}: bodies differ:  ${file}  (.claude ${linesA} lines, .agents ${linesB} lines)`,
      );
    }
  }
}

if (findings === 0) console.log("skill trees match (modulo frontmatter)");
else console.log(`\n${findings} drift item(s) — deliberate drift is fine, unreviewed drift is not`);
