/**
 * Configures pi-paster. The package ships with its inline image UX switched
 * off, so installing it alone gives you `[#image 1]` placeholders and
 * attachments but no preview — which is the part that matters when you paste
 * UI screenshots and want to confirm you attached the right one.
 *
 * `customEditor.enabled` swaps pi's input editor for `PasterEditor extends
 * CustomEditor`. That is safe alongside the editor-cursor extension: the
 * prototype chain is `CustomEditor -> Editor -> Object` and CustomEditor
 * declares no `render` of its own, so it inherits the patched
 * `Editor.prototype.render` and keeps the terminal's bar cursor.
 *
 * Loaded instead of the package's own auto-registration — settings.json filters
 * the package to `extensions: []` so paster is imported here rather than
 * registering itself, which would otherwise run it twice.
 */

// Imported from src, not dist, and this matters: jiti imports a .mjs natively,
// so `dist/index.mjs`'s bare `@earendil-works/*` imports bypass pi's alias table
// and resolve by plain Node lookup to the 0.82.0 copy under
// ~/.pi/agent/node_modules (installed as typecheck deps) — a *different module
// instance* from the app's 0.82.1. paster's editor then extended an Editor class
// that editor-cursor had never patched, so its drawn cursor survived.
//
// src/index.ts is TypeScript, so jiti transpiles it and applies the alias table,
// resolving CustomEditor/Editor to the app's own copies. This is also what pi's
// package loader does normally — package.json declares
// `"pi": {"extensions": ["./src/index.ts"]}` — so this rejoins the supported
// path rather than working around it, and fixes the version skew too.
import {
  createPaster,
  PasterEditor,
} from "../../npm/node_modules/pi-paster/src/index.ts";

/**
 * Upstream bug (pi-paster src/editor.ts:147-155): `handleInput` returns early
 * when `handleAtomicPlaceholderNavigation` consumes the key, skipping the
 * `updateCursorPreview()` call at the end of the method. Arrowing onto a
 * placeholder is exactly that path — and the front of a placeholder is the only
 * cursor position where `findPlaceholderAtCursor(…, "hover")` matches
 * (`col >= start && col < end`). So the preview never fired for the one case it
 * exists to serve.
 *
 * Re-running updateCursorPreview after every key is safe: it early-returns when
 * the placeholder under the cursor has not changed, so this costs one
 * comparison per keystroke and cannot double-render.
 */
function patchPreviewOnNavigation() {
  type Patched = ((data: string) => void) & { __previewOnNav?: boolean };
  // `updateCursorPreview` is private on the class, so the prototype is reached
  // through unknown — it is a plain property at runtime.
  type EditorProto = {
    handleInput?: Patched;
    updateCursorPreview?: () => void;
  };
  const prototype = PasterEditor?.prototype as unknown as
    EditorProto | undefined;
  const original = prototype?.handleInput;
  if (!prototype || typeof original !== "function" || original.__previewOnNav) {
    return;
  }

  const patched: Patched = function (this: EditorProto, data: string) {
    original.call(this, data);
    this.updateCursorPreview?.();
  };
  patched.__previewOnNav = true;
  prototype.handleInput = patched;
}

patchPreviewOnNavigation();

export default createPaster({
  customEditor: {
    enabled: true,
    // Preview above the input while the cursor sits inside a placeholder.
    showImagePreview: true,
    // Backspace over `[#image 1]` removes the whole placeholder, not one char.
    deletePlaceholderAsBlock: true,
  },
  // Collapsible keeps submitted screenshots from dominating the scrollback,
  // consistent with the 3-line subagent previews and collapsed tool output.
  submittedPreviewStyle: "collapsible",
  // The agent usually needs the file path too — it edits the UI it is shown.
  includeImagePathsInPrompt: true,
  imageCompression: {
    // /image-compress forks the session with images replaced by text summaries;
    // useful when a long screenshot-heavy thread starts crowding the window.
    enabled: true,
  },
});
