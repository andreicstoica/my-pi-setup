#!/usr/bin/env node
/**
 * Re-apply the cache-friendly image caps to the installed pi-paster.
 *
 * Why: paster only shrinks an attachment when it breaks an Anthropic API hard
 * limit (5 MB / 8000 px), so a Retina screen grab (measured: 5120x2880, 4.1 MB)
 * is attached untouched and then lives in the context for the rest of the
 * session. Every prompt-cache miss re-uploads it — and orchestration sessions
 * miss the cache constantly, because `subagent_wait` idles longer than the
 * cache lives (measured: 37% hit rate, 202M uncached input tokens, one session).
 *
 * The fix needs no logic change: the optimizer already resizes to the dimension
 * cap, then runs a JPEG quality ladder to the byte cap. Lowering the two caps
 * turns it into a general downscaler.
 *
 * pi-paster sits in node_modules, so `pi update` / a reinstall reverts this.
 * Re-run the script after either. It is idempotent.
 *
 * Tune without re-patching: PI_PASTER_MAX_EDGE (px), PI_PASTER_MAX_BYTES.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "npm/node_modules/pi-paster/src");
const MARKER = "pi-local: cache-friendly image caps";

const edits = [
  {
    file: join(pkg, "types.ts"),
    from: `export const ANTHROPIC_MAX_DIMENSION = 8000;
export const ANTHROPIC_MAX_IMAGE_BYTES = 5 * 1024 * 1024;`,
    to: `// ${MARKER} — these are no longer the Anthropic hard limits, they are the
// budget we want an attachment to cost in context. The optimizer's own comment
// notes any downscale at or above ~2600 px is lossless to Claude, and OpenAI
// tiles images too, so 2000 px keeps UI text readable at ~6x fewer pixels than
// a 5K grab. Override per-shell with PI_PASTER_MAX_EDGE / PI_PASTER_MAX_BYTES.
const paster_envInt = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};
export const ANTHROPIC_MAX_DIMENSION = paster_envInt("PI_PASTER_MAX_EDGE", 2000);
export const ANTHROPIC_MAX_IMAGE_BYTES = paster_envInt("PI_PASTER_MAX_BYTES", 400 * 1024);`,
  },
  {
    file: join(pkg, "optimize-image.ts"),
    // The label hard-codes the old cap.
    from: "actions.push(`resize to ${workW}x${workH} (8000px cap)`);",
    to: "actions.push(`resize to ${workW}x${workH} (${ANTHROPIC_MAX_DIMENSION}px cap)`);",
  },
  {
    file: join(pkg, "optimize-image.ts"),
    // With a 2000 px cap, step 1 already resizes to 2000, so every rung of the
    // old ladder is skipped by its `<= longEdge` guard and the byte cap can
    // never be reached by shrinking. Add rungs below the cap.
    from: `const SHRINK_LADDER = [6000, 4000, 3000, 2000];`,
    to: `// ${MARKER} — rungs below the dimension cap, so the byte cap is reachable.
const SHRINK_LADDER = [6000, 4000, 3000, 2000, 1600, 1200];`,
  },
];

let changed = 0;
for (const { file, from, to } of edits) {
  const src = readFileSync(file, "utf8");
  if (src.includes(MARKER) && !src.includes(from)) {
    console.log(`already patched: ${file.replace(root, "~/.pi/agent")}`);
    continue;
  }
  if (!src.includes(from)) {
    console.error(`FAILED: anchor not found in ${file}`);
    console.error("  pi-paster changed upstream — re-check the patch by hand.");
    process.exit(1);
  }
  writeFileSync(file, src.replace(from, to));
  console.log(`patched: ${file.replace(root, "~/.pi/agent")}`);
  changed++;
}
console.log(changed ? "done" : "no change needed");
