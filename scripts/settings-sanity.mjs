/**
 * Settings sanity — the check that would have caught the July luna incident.
 *
 * Every `/model` pick and Ctrl+P cycle rewrites `defaultModel` in
 * settings.json, so a stray keypress silently demoted the orchestrator to
 * luna for days (Jul 25-27). Model choice is deliberate here; this script
 * fails loudly when the persisted default has drifted from it. Update
 * EXPECTED below when the intended default actually changes.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXPECTED = {
  defaultProvider: "openai-codex",
  defaultModel: "gpt-5.6-sol",
  defaultThinkingLevel: "high",
};

const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

const problems = [];

for (const [key, expected] of Object.entries(EXPECTED)) {
  if (settings[key] !== expected) {
    problems.push(
      `${key} is ${JSON.stringify(settings[key])}, expected ${JSON.stringify(expected)} — a /model pick or Ctrl+P cycle likely rewrote it`,
    );
  }
}

const enabled = settings.enabledModels;
if (!Array.isArray(enabled) || enabled.length === 0) {
  problems.push("enabledModels is missing — every catalogue model is cyclable");
} else {
  for (const pattern of enabled) {
    if (pattern.includes("*")) {
      problems.push(
        `enabledModels contains glob "${pattern}" — enumerate models explicitly so new cheap models don't slip into the cycle`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`settings sanity FAILED (${settingsPath}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `settings sanity OK: ${settings.defaultProvider}/${settings.defaultModel} @ ${settings.defaultThinkingLevel}, ${enabled.length} models enabled`,
);
