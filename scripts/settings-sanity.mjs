// `/model` and Ctrl+P persist their selection. Keep this guard aligned with the intended default.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXPECTED = {
  defaultProvider: "openai-codex",
  defaultModel: "gpt-5.6-terra",
  defaultThinkingLevel: "medium",
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
