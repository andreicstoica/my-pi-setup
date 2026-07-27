/**
 * Faint background wash for diff rows, derived from the active theme.
 *
 * This cannot live in a theme file. Two independent reasons: the theme schema
 * sets `additionalProperties: false` with no background key for diffs, so a
 * `toolDiffAddedBg` entry breaks theme loading silently; and more fundamentally
 * pi's diff renderer only ever calls `theme.fg(…)` for diff lines
 * (`dist/modes/interactive/components/diff.js`), so even a legal background key
 * would never be read. The row background has to be injected at the `fg` seam,
 * which is why it rides along with the tool-title patch instead.
 */

/** How far the diff colour travels toward the background. Higher = fainter. */
const TINT_TOWARD_BACKGROUND = 0.88;

/** The row background to blend against — every theme defines it. */
export const BACKGROUND_KEY = "toolSuccessBg";

export const TINTED_KEYS = new Set(["toolDiffAdded", "toolDiffRemoved"]);

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
