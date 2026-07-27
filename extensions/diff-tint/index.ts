/**
 * Tinted diff rows: a faint green wash behind added lines, red behind removed
 * ones, so a block of changes reads as two shapes instead of two colours of
 * text. Codex's diffs get their legibility from exactly this.
 *
 * pi renders diff lines as `theme.fg("toolDiffAdded", …)` with no background
 * (`dist/modes/interactive/components/diff.js`), and the theme schema has no
 * background key for them — `additionalProperties: false`, so inventing
 * `toolDiffAddedBg` in a theme file would break the theme, silently, the way
 * `mdQuoteBorder: "accent"` did. Hence the same seam `tool-colors` uses:
 * `Theme.prototype.fg` is a real prototype method, so wrapping it survives theme
 * switches, hot reload, and auto light/dark resync.
 *
 * The tint is DERIVED, not hardcoded: the theme's own diff colour is blended
 * most of the way toward its row background, so one-light gets a pale green and
 * gruvbox-dark-hard gets a dark one with no per-theme configuration.
 *
 * Composition: `fg` resets only the foreground (`\x1b[39m`) and never the
 * background, so wrapping its output in a background pair is safe — the inner
 * reset cannot clear our wash. Intra-line `theme.inverse()` markers still swap
 * against the tint, which is the intended emphasis.
 *
 * Known limit: the wash ends where the text ends, because `fg` sees a string and
 * not the pane width. Full-bleed rows would mean overriding the `edit` tool's
 * renderResult, which requires reimplementing its execute to match the details
 * shape — a much bigger change for the remaining few columns.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Theme } from "@earendil-works/pi-coding-agent";

/** How far the diff colour travels toward the background. Higher = fainter. */
const TINT_TOWARD_BACKGROUND = 0.88;

/** The row background to blend against — every theme defines it. */
const BACKGROUND_KEY = "toolSuccessBg";

const TINTED_KEYS = new Set(["toolDiffAdded", "toolDiffRemoved"]);

type Rgb = [number, number, number];

/** Pull the RGB out of a truecolor SGR sequence; undefined for 256-colour mode. */
export function parseTruecolor(ansi: string): Rgb | undefined {
  const match = ansi.match(/\x1b\[(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/);
  if (!match) return undefined;
  const rgb = [Number(match[1]), Number(match[2]), Number(match[3])] as Rgb;
  return rgb.every((v) => v >= 0 && v <= 255) ? rgb : undefined;
}

export function blend(from: Rgb, to: Rgb, amount: number): Rgb {
  const clamped = Math.max(0, Math.min(1, amount));
  return [0, 1, 2].map((i) =>
    Math.round(from[i]! + (to[i]! - from[i]!) * clamped),
  ) as Rgb;
}

export function backgroundSequence([r, g, b]: Rgb) {
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Faint wash for a diff colour against a row background. Undefined when either
 * colour is not truecolor, so 256-colour terminals keep the plain rendering
 * rather than getting an approximated block.
 */
export function tintSequence(
  diffAnsi: string,
  backgroundAnsi: string,
  amount = TINT_TOWARD_BACKGROUND,
) {
  const diff = parseTruecolor(diffAnsi);
  const background = parseTruecolor(backgroundAnsi);
  if (!diff || !background) return undefined;
  return backgroundSequence(blend(diff, background, amount));
}

type FgFn = (color: string, text: string) => string;
type PatchedFg = FgFn & { __diffTint?: boolean };

function patchDiffTint() {
  const prototype = Theme.prototype as unknown as { fg?: PatchedFg };
  const original = prototype.fg;
  if (typeof original !== "function") return "Theme.prototype.fg is missing";
  if (original.__diffTint) return undefined;

  // Per-instance, per-key: a theme switch installs a new Theme, and a stale
  // cache would leave yesterday's palette washing today's rows.
  const cache = new WeakMap<object, Map<string, string | undefined>>();

  const patched: PatchedFg = function (
    this: { bg?: (color: string, text: string) => string },
    color: string,
    text: string,
  ) {
    const rendered = original.call(this, color, text);
    if (!TINTED_KEYS.has(color)) return rendered;

    let perTheme = cache.get(this);
    if (!perTheme) {
      perTheme = new Map();
      cache.set(this, perTheme);
    }
    if (!perTheme.has(color)) {
      let tint: string | undefined;
      try {
        // Probe through the ORIGINAL fg: calling this.fg here would recurse.
        tint = tintSequence(
          original.call(this, color, ""),
          this.bg?.(BACKGROUND_KEY, "") ?? "",
        );
      } catch {
        tint = undefined;
      }
      perTheme.set(color, tint);
    }

    const tint = perTheme.get(color);
    // Reset background only: the caller may still be inside a foreground run.
    return tint ? `${tint}${rendered}\x1b[49m` : rendered;
  };
  patched.__diffTint = true;
  prototype.fg = patched;
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const failure = patchDiffTint();

  pi.on("session_start", (_event, ctx) => {
    if (failure && ctx.mode === "tui") {
      ctx.ui.notify(`diff-tint: ${failure}`, "warning");
    }
  });
}
