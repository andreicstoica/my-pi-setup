import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chrome from "./src/chrome.ts";
import tools from "./src/tools.ts";

export default function polish(pi: ExtensionAPI) {
  tools(pi);
  chrome(pi);
}
