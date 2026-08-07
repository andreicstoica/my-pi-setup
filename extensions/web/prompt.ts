/**
 * Model-facing copy for the two web tools. Both are Firecrawl-backed, but the
 * names are deliberately about what they DO, not who serves them: `search`
 * collided with file search in the model's head, and `scrape` said nothing
 * about being the way to read a URL.
 */

/** Describes web search and its model-context output limits. */
export const SEARCH_TOOL_DESCRIPTION =
  "Search the web and return web, news, or image results. This is the INTERNET, not the local workspace — use grep/glob/file search for anything in the repo. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds the current-information search capability to the model's tool prompt. */
export const SEARCH_PROMPT_SNIPPET =
  "Search the web for current information beyond the local workspace.";

/** Guides the model on when to search and when to follow with a fetch. */
export const SEARCH_PROMPT_GUIDELINES = [
  "Use web_search when the user asks for current web information, discovery, or sources beyond the local workspace. It never searches this repo — that is grep, glob, and file search.",
  "Use web_fetch when you already have a URL, including one the user pasted. Do not run a search first just to reach a page you can already name.",
  "Follow web_search with web_fetch when a result's snippet is not enough and you need the page's full readable content.",
];

/** Model-facing schema descriptions for web search parameters. */
export const SEARCH_PARAMETER_DESCRIPTIONS = {
  query: "The web search query.",
  limit: "Maximum number of results. Defaults to 5.",
  scrapeResults:
    "Whether to include markdown from each result page. Defaults to false.",
};

/** Describes single-page fetching and its model-context output limits. */
export const FETCH_TOOL_DESCRIPTION =
  "Fetch one web page and return its readable content as markdown. Use this for any URL you already have, including one the user pasted — no search needed first. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Model-facing schema descriptions for web fetch parameters. */
export const FETCH_PARAMETER_DESCRIPTIONS = {
  url: "The URL to fetch.",
  onlyMainContent: "Return only the main page content. Defaults to true.",
  waitFor:
    "Milliseconds to wait before capture, useful for JavaScript-heavy pages.",
  timeout: "Request timeout in milliseconds. Defaults to 30000.",
  includeMetadata:
    "Append page metadata to the markdown. Defaults to false; metadata remains available in tool details.",
};
