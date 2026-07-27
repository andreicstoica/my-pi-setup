import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { crawlEffect, searchGroups, type CrawlClient } from "./index.ts";

test("cancels the remote crawl when polling is interrupted", async () => {
  let pollingStarted!: () => void;
  const startedPolling = new Promise<void>((resolve) => {
    pollingStarted = resolve;
  });
  const cancelledJobs: string[] = [];

  const client: CrawlClient = {
    startCrawl: async (url) => ({ id: "crawl-123", url }),
    getCrawlStatus: async () => {
      pollingStarted();
      return new Promise(() => undefined);
    },
    cancelCrawl: async (jobId) => {
      cancelledJobs.push(jobId);
      return true;
    },
  };

  const controller = new AbortController();
  const running = Effect.runPromise(
    crawlEffect(client, "https://example.com", { limit: 1 }),
    { signal: controller.signal },
  );
  const interrupted = assert.rejects(running);

  await startedPolling;
  controller.abort();
  await interrupted;

  assert.deepEqual(cancelledJobs, ["crawl-123"]);
});

test("search groups normalize bare results and scraped documents", () => {
  const groups = searchGroups({
    web: [
      {
        url: "https://www.bevel.health/",
        title: "Bevel",
        description: "coach",
      },
      {
        metadata: { sourceURL: "https://example.com/a", title: "Doc" },
        markdown: "# body",
      },
    ],
    news: [{ url: "https://news.example.com/x", date: "2026-07-01" }],
    images: [],
  });

  assert.deepEqual(
    groups.map((group) => group.source),
    ["web", "news"],
  );
  assert.deepEqual(groups[0]?.rows[0], {
    url: "https://www.bevel.health/",
    title: "Bevel",
    snippet: "coach",
    extra: undefined,
  });
  const scraped = groups[0]?.rows[1];
  assert.equal(scraped?.url, "https://example.com/a");
  assert.equal(scraped?.title, "Doc");
  assert.match(scraped?.extra ?? "", /scraped$/);
  assert.equal(groups[1]?.rows[0]?.extra, "2026-07-01");
});
