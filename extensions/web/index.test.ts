import assert from "node:assert/strict";
import test from "node:test";
import { searchGroups } from "./index.ts";

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

test("an empty source is dropped rather than rendering a headed empty group", () => {
  assert.deepEqual(searchGroups({ web: [], news: [], images: [] }), []);
  assert.deepEqual(searchGroups(undefined), []);
});
