/**
 * Tool-title colour mapping, kept free of pi imports so it is unit-testable.
 *
 * Every built-in pi tool renders its title through `theme.fg("toolTitle", …)`
 * (see `dist/core/tools/*.js`), so all of them come out one colour and a long
 * transcript reads as a wall of same-hue lines. There is no extension hook for
 * re-rendering built-in tools, so this re-points the `toolTitle` lookup at a
 * different existing token based on the title text.
 */

export type TitleKind = "shell" | "read" | "mutate" | "remote";

/** Tokens chosen because they are distinct hues in both one-light and gruvbox-dark-hard. */
export const KIND_COLOR = {
  // green — matches pi's own `bashMode` editor border
  shell: "success",
  // blue
  read: "mdLink",
  // orange
  mutate: "warning",
  // aqua / cyan
  remote: "mdCode",
} as const satisfies Record<TitleKind, string>;

export const FALLBACK_COLOR = "toolTitle";

/**
 * Matched against the de-ANSI'd title. Built-in titles are a bare verb
 * (`read`, `edit`, `grep`, `read image`) except bash, which renders as
 * `$ <command>`. Extension tools follow the same one-word convention.
 */
const KIND_PATTERNS: ReadonlyArray<readonly [TitleKind, RegExp]> = [
  ["shell", /^\$/],
  ["mutate", /^(write|edit|apply_patch|multi_edit)\b/],
  ["read", /^(read|ls|find|grep|fd|rg|glob|tree)\b/],
  [
    "remote",
    /^(subagent|workflow|terminal|firecrawl|search|scrape|crawl|fetch|web)/,
  ],
];

// Control sequences are stripped before matching so bold/colour wrappers on the
// title do not defeat the anchors above.
const ANSI = /\x1b\[[0-9;]*m/g;
/** Leading glyph, stripped before classifying so decoration is order-safe. */
const GLYPH_PREFIX = /^●\s*/;

export function classify(text: string): TitleKind | undefined {
  // The glyph is stripped as well as ANSI: a title that has already been
  // decorated (a re-render of a cached string) must still classify, or it would
  // silently fall back to the default colour.
  const plain = text
    .replace(ANSI, "")
    .replace(GLYPH_PREFIX, "")
    .trim()
    .toLowerCase();
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(plain)) return kind;
  }
  return undefined;
}

/** The theme token a given rendered title should use. */
export function colorFor(text: string) {
  const kind = classify(text);
  return kind ? KIND_COLOR[kind] : FALLBACK_COLOR;
}

/**
 * Leading glyph on every tool title, so a streaming transcript can be scanned
 * by shape as well as read — the trick that makes Claude Code's action log
 * followable. Colour already encodes *what kind* of action it is, so one glyph
 * is enough; a different symbol per kind would be noise on top of that.
 */
export const TITLE_GLYPH = "● ";

/**
 * Prefix a title, unless it already carries the glyph. `fg("toolTitle", …)` is
 * called once per title with the whole string, so this cannot double up mid
 * render — but a re-render of the same cached string could, hence the guard.
 */
export function decorateTitle(text: string) {
  return text.startsWith(TITLE_GLYPH) ? text : `${TITLE_GLYPH}${text}`;
}

/**
 * The remap the prototype patch in ../index.ts applies. Kept here, separate
 * from any pi import, so the mapping stays unit-testable on its own.
 */
export function shouldRemap(color: string, text: string) {
  if (color !== FALLBACK_COLOR) return undefined;
  const mapped = colorFor(text);
  return mapped === FALLBACK_COLOR ? undefined : mapped;
}
