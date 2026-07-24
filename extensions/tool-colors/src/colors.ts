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

export function classify(text: string): TitleKind | undefined {
  const plain = text.replace(ANSI, "").trim().toLowerCase();
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

/** Minimal shape this module needs from pi's Theme class. */
export interface ThemeLike {
  fg(color: string, text: string): string;
}

/**
 * Wrap a theme so `fg("toolTitle", …)` is re-pointed per tool kind. A proxy
 * (rather than a subclass) keeps the original instance's private colour maps
 * and prototype intact, so `instanceof Theme` and every untouched method
 * behave exactly as before.
 */
export function withToolColors<T extends ThemeLike>(theme: T): T {
  return new Proxy(theme, {
    get(target, property, receiver) {
      if (property !== "fg") return Reflect.get(target, property, receiver);

      return function (color: string, text: string) {
        const call = (token: string) => target.fg(token, text);
        if (color !== FALLBACK_COLOR) return call(color);
        try {
          return call(colorFor(text));
        } catch {
          // A theme missing the mapped token must not break rendering.
          return call(FALLBACK_COLOR);
        }
      };
    },
  });
}
