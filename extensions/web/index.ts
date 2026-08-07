import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
  truncateHead,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cause, Data, Effect, Exit } from "effect";
import { Firecrawl, type CrawlJob, type CrawlOptions } from "firecrawl";
import { Type } from "typebox";
import {
  CRAWL_PARAMETER_DESCRIPTIONS,
  CRAWL_TOOL_DESCRIPTION,
  SCRAPE_PARAMETER_DESCRIPTIONS,
  SCRAPE_TOOL_DESCRIPTION,
  SEARCH_PARAMETER_DESCRIPTIONS,
  SEARCH_PROMPT_GUIDELINES,
  SEARCH_PROMPT_SNIPPET,
  SEARCH_TOOL_DESCRIPTION,
} from "./prompt.ts";

function readEnvValue(name: string) {
  if (process.env[name]) return process.env[name];

  const envPath = join(homedir(), ".pi", "agent", ".env");
  let envText = "";

  try {
    envText = readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }

  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match || match[1] !== name) continue;

    const value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }

    return value.replace(/\s+#.*$/, "");
  }

  return undefined;
}

class MissingApiKeyError extends Data.TaggedError("MissingApiKeyError")<{
  readonly message: string;
}> {}

function createClient() {
  const apiKey = readEnvValue("FIRECRAWL_API_KEY");
  if (!apiKey) {
    return Effect.fail(
      new MissingApiKeyError({
        message:
          "Missing FIRECRAWL_API_KEY in the environment or ~/.pi/agent/.env",
      }),
    );
  }

  return Effect.try({
    try: () => new Firecrawl({ apiKey }),
    catch: (cause) =>
      new FirecrawlError({ message: errorMessage(cause), cause }),
  });
}

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

class FirecrawlError extends Data.TaggedError("FirecrawlError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function firecrawlRequest<T>(request: () => Promise<T>) {
  return Effect.tryPromise({
    try: request,
    catch: (cause) =>
      new FirecrawlError({ message: errorMessage(cause), cause }),
  });
}

class OutputError extends Data.TaggedError("OutputError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function formatOutput(value: unknown, operation: string) {
  return Effect.tryPromise({
    try: async () => {
      const output = typeof value === "string" ? value : stringify(value);
      const truncation = truncateHead(output, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      if (!truncation.truncated) return output;

      const outputDirectory = await mkdtemp(join(tmpdir(), "pi-firecrawl-"));
      const outputPath = join(outputDirectory, `${operation}.json`);
      await writeFile(outputPath, output, "utf8");

      return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
    },
    catch: (cause) => new OutputError({ message: errorMessage(cause), cause }),
  });
}

export type CrawlClient = Pick<
  Firecrawl,
  "startCrawl" | "getCrawlStatus" | "cancelCrawl"
>;

function pollCrawl(
  client: CrawlClient,
  jobId: string,
): Effect.Effect<CrawlJob, FirecrawlError> {
  return firecrawlRequest(() => client.getCrawlStatus(jobId)).pipe(
    Effect.flatMap((job) =>
      job.status === "scraping"
        ? Effect.sleep("2 seconds").pipe(
            Effect.flatMap(() =>
              Effect.suspend(() => pollCrawl(client, jobId)),
            ),
          )
        : Effect.succeed(job),
    ),
  );
}

/** Brackets the remote job so every non-successful exit attempts cancellation. */
export function crawlEffect(
  client: CrawlClient,
  url: string,
  options: CrawlOptions,
) {
  return Effect.acquireUseRelease(
    firecrawlRequest(() => client.startCrawl(url, options)),
    (job) => pollCrawl(client, job.id),
    (job, exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : firecrawlRequest(() => client.cancelCrawl(job.id)).pipe(
            Effect.timeout("10 seconds"),
            Effect.ignore,
          ),
  );
}

function operationError(operation: string, error: unknown) {
  if (error instanceof MissingApiKeyError) return new Error(error.message);

  const cause =
    error instanceof FirecrawlError || error instanceof OutputError
      ? error.cause
      : error;
  return new Error(`Firecrawl ${operation} failed: ${errorMessage(error)}`, {
    cause,
  });
}

/** Shared Effect pipeline with a single Promise boundary for the tool API. */
async function runFirecrawl<T>(
  operation: string,
  status: string,
  timeout: number,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<T | undefined> | undefined,
  request: (
    client: Firecrawl,
  ) => Effect.Effect<
    { details: T; output: unknown },
    FirecrawlError | OutputError
  >,
) {
  const program = Effect.gen(function* () {
    const client = yield* createClient();
    yield* Effect.sync(() =>
      onUpdate?.({
        content: [{ type: "text", text: status }],
        details: undefined,
      }),
    );

    const { details, output } = yield* request(client).pipe(
      Effect.timeout(timeout),
    );
    const formatted = yield* formatOutput(output, operation);

    return {
      content: [{ type: "text" as const, text: formatted }],
      details,
    } satisfies AgentToolResult<T | undefined>;
  });

  const exit = await Effect.runPromiseExit(
    program,
    signal ? { signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error("Firecrawl request cancelled");
  }
  throw operationError(operation, Cause.squash(exit.cause));
}

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** One normalized row, whatever source (web/news/images) produced it. */
interface SearchRow {
  url?: string;
  title?: string;
  snippet?: string;
  extra?: string;
}

const SEARCH_COLLAPSED_ROWS = 5;
export const DEFERRED_FIRECRAWL_TOOLS = ["crawl", "scrape"] as const;
const deferredFirecrawlToolSet = new Set<string>(DEFERRED_FIRECRAWL_TOOLS);

export function deferFollowupTools(activeTools: readonly string[]) {
  return activeTools.filter((name) => !deferredFirecrawlToolSet.has(name));
}

function activateFollowupTools(pi: ExtensionAPI) {
  pi.setActiveTools([
    ...new Set([...pi.getActiveTools(), ...DEFERRED_FIRECRAWL_TOOLS]),
  ]);
}

function hostOf(url: string | undefined) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] ?? "";
  }
}

function oneLine(text: string | undefined, max: number) {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Firecrawl returns either a bare result or a scraped Document per source. */
function toRows(value: unknown): SearchRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const metadata = (entry.metadata ?? {}) as Record<string, unknown>;
    const url =
      typeof entry.url === "string"
        ? entry.url
        : typeof metadata.sourceURL === "string"
          ? metadata.sourceURL
          : undefined;
    const title =
      typeof entry.title === "string"
        ? entry.title
        : typeof metadata.title === "string"
          ? metadata.title
          : undefined;
    const snippet = [
      entry.description,
      entry.snippet,
      metadata.description,
      entry.markdown,
    ].find((candidate): candidate is string => typeof candidate === "string");
    const extra = [
      typeof entry.date === "string" ? entry.date : undefined,
      typeof entry.imageWidth === "number" &&
      typeof entry.imageHeight === "number"
        ? `${entry.imageWidth}×${entry.imageHeight}`
        : undefined,
      typeof entry.markdown === "string"
        ? `${formatSize(Buffer.byteLength(entry.markdown, "utf8"))} scraped`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    return { url, title, snippet, extra: extra || undefined };
  });
}

export function searchGroups(details: unknown) {
  const data = (details ?? {}) as Record<string, unknown>;
  return (["web", "news", "images"] as const)
    .map((source) => ({ source, rows: toRows(data[source]) }))
    .filter((group) => group.rows.length > 0);
}

function renderSearchRow(
  row: SearchRow,
  index: number,
  theme: ThemeLike,
  expanded: boolean,
) {
  const number = theme.fg("dim", `${(index + 1).toString().padStart(2)}. `);
  const host = hostOf(row.url);
  let text =
    number +
    theme.fg(
      "accent",
      oneLine(row.title, expanded ? 120 : 72) || host || "(untitled)",
    );
  if (host) text += theme.fg("muted", `  ${host}`);
  if (row.extra) text += theme.fg("dim", `  ${row.extra}`);
  if (!expanded) return text;
  if (row.url) text += `\n    ${theme.fg("dim", row.url)}`;
  const snippet = oneLine(row.snippet, 240);
  if (snippet) text += `\n    ${theme.fg("toolOutput", snippet)}`;
  return text;
}

export default function firecrawlTools(pi: ExtensionAPI) {
  // Search is the common entry point. Load the expensive, less common
  // follow-up tools only after the model uses search.
  pi.on("session_start", () => {
    if (pi.getActiveTools().includes("search")) {
      pi.setActiveTools(deferFollowupTools(pi.getActiveTools()));
    }
  });

  pi.registerTool({
    name: "search",
    label: "Search Web",
    description: SEARCH_TOOL_DESCRIPTION,
    promptSnippet: SEARCH_PROMPT_SNIPPET,
    promptGuidelines: SEARCH_PROMPT_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({
        description: SEARCH_PARAMETER_DESCRIPTIONS.query,
      }),
      limit: Type.Optional(
        Type.Number({
          description: SEARCH_PARAMETER_DESCRIPTIONS.limit,
          minimum: 1,
          maximum: 20,
        }),
      ),
      source: Type.Optional(StringEnum(["web", "news", "images"] as const)),
      scrapeResults: Type.Optional(
        Type.Boolean({
          description: SEARCH_PARAMETER_DESCRIPTIONS.scrapeResults,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) => {
      activateFollowupTools(pi);
      return runFirecrawl(
        "search",
        `Searching Firecrawl for: ${params.query}`,
        35_000,
        signal,
        onUpdate,
        (client) =>
          firecrawlRequest(() =>
            client.search(params.query, {
              limit: params.limit ?? 5,
              sources: [params.source ?? "web"],
              scrapeOptions: params.scrapeResults
                ? { formats: ["markdown"], timeout: 30_000 }
                : undefined,
              timeout: 30_000,
            }),
          ).pipe(Effect.map((result) => ({ details: result, output: result }))),
      );
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("search "));
      text += theme.fg("accent", args.query ? `"${args.query}"` : "…");
      const flags = [
        args.source && args.source !== "web" ? args.source : undefined,
        args.limit !== undefined ? `limit=${args.limit}` : undefined,
        args.scrapeResults ? "scraped" : undefined,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += " " + theme.fg("dim", flags.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

      const groups = searchGroups(result.details);
      const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
      if (total === 0) return new Text(theme.fg("dim", "No results"), 0, 0);

      let text = theme.fg(
        "success",
        `${total} ${total === 1 ? "result" : "results"}`,
      );
      for (const group of groups) {
        if (groups.length > 1) {
          text += `\n${theme.fg("muted", group.source)}`;
        }
        const shown = expanded
          ? group.rows
          : group.rows.slice(0, SEARCH_COLLAPSED_ROWS);
        for (const [index, row] of shown.entries()) {
          text += `\n${renderSearchRow(row, index, theme, expanded)}`;
        }
        const hidden = group.rows.length - shown.length;
        if (hidden > 0) {
          text += `\n${theme.fg("dim", `    … +${hidden} more (${keyHint("app.tools.expand", "to expand")})`)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "crawl",
    label: "Crawl Website",
    description: CRAWL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      url: Type.String({ description: CRAWL_PARAMETER_DESCRIPTIONS.url }),
      limit: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.limit,
          minimum: 1,
          maximum: 100,
        }),
      ),
      maxDiscoveryDepth: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.maxDiscoveryDepth,
          minimum: 0,
        }),
      ),
      includePaths: Type.Optional(
        Type.Array(Type.String(), {
          description: CRAWL_PARAMETER_DESCRIPTIONS.includePaths,
        }),
      ),
      excludePaths: Type.Optional(
        Type.Array(Type.String(), {
          description: CRAWL_PARAMETER_DESCRIPTIONS.excludePaths,
        }),
      ),
      crawlEntireDomain: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.crawlEntireDomain,
        }),
      ),
      allowSubdomains: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.allowSubdomains,
        }),
      ),
      sitemap: Type.Optional(StringEnum(["include", "skip", "only"] as const)),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.onlyMainContent,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.timeout,
          minimum: 1,
          maximum: 600,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        "crawl",
        `Crawling up to ${params.limit ?? 20} pages from: ${params.url}`,
        ((params.timeout ?? 120) + 5) * 1_000,
        signal,
        onUpdate,
        (client) =>
          crawlEffect(client, params.url, {
            limit: params.limit ?? 20,
            maxDiscoveryDepth: params.maxDiscoveryDepth,
            includePaths: params.includePaths,
            excludePaths: params.excludePaths,
            crawlEntireDomain: params.crawlEntireDomain,
            allowSubdomains: params.allowSubdomains,
            sitemap: params.sitemap,
            scrapeOptions: {
              formats: ["markdown"],
              onlyMainContent: params.onlyMainContent ?? true,
            },
          }).pipe(
            Effect.map((result) => ({ details: result, output: result })),
          ),
      ),
  });

  pi.registerTool({
    name: "scrape",
    label: "Scrape Page",
    description: SCRAPE_TOOL_DESCRIPTION,
    parameters: Type.Object({
      url: Type.String({ description: SCRAPE_PARAMETER_DESCRIPTIONS.url }),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.onlyMainContent,
        }),
      ),
      waitFor: Type.Optional(
        Type.Number({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.waitFor,
          minimum: 0,
          maximum: 60_000,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.timeout,
          minimum: 1,
          maximum: 120_000,
        }),
      ),
      includeMetadata: Type.Optional(
        Type.Boolean({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.includeMetadata,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        "scrape",
        `Scraping page with Firecrawl: ${params.url}`,
        (params.timeout ?? 30_000) + 5_000,
        signal,
        onUpdate,
        (client) =>
          firecrawlRequest(() =>
            client.scrape(params.url, {
              formats: ["markdown"],
              onlyMainContent: params.onlyMainContent ?? true,
              waitFor: params.waitFor,
              timeout: params.timeout ?? 30_000,
            }),
          ).pipe(
            Effect.flatMap((document) =>
              Effect.try({
                try: () => {
                  const metadata =
                    params.includeMetadata && document.metadata
                      ? `\n\nMetadata:\n${stringify(document.metadata)}`
                      : "";
                  const markdown =
                    document.markdown?.trim() ||
                    "No markdown content returned.";

                  return {
                    details: document,
                    output: `${markdown}${metadata}`,
                  };
                },
                catch: (cause) =>
                  new OutputError({ message: errorMessage(cause), cause }),
              }),
            ),
          ),
      ),
  });
}
