import { afterEach, expect, it, vi } from "vitest";
import { BundleSearchDirectory } from "./bundle-search.ts";

const BUNDLE_BASE_URL = "https://bundles.test/";
const KEY = "0123456789abcdef";
const emptyIndex = {
  colors: [],
  models: [],
  catalogParts: [],
  trackCatalog: { n: 16, pieces: [] },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("asks the edge to keep a published manifest for a year and never keep a 404 or a failure, in the edge or in memory", async () => {
  const answers = [
    new Response("not found", { status: 404 }),
    new Response("unavailable", { status: 503 }),
    new Response(JSON.stringify(emptyIndex), { status: 200 }),
  ];
  const fetched: Array<{ readonly url: string; readonly init: unknown }> = [];
  vi.stubGlobal("fetch", async (url: URL, init: unknown) => {
    fetched.push({ url: url.href, init });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("the manifest was fetched again after it was found");
    return answer;
  });
  const directory = new BundleSearchDirectory();

  const kinds = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    kinds.push((await directory.find(BUNDLE_BASE_URL, KEY)).kind);
  }

  expect(kinds).toEqual(["missing", "unreadable", "found", "found"]);
  expect(fetched.map(({ url }) => url)).toEqual(
    Array.from({ length: 3 }, () => `${BUNDLE_BASE_URL}standard/manifest.${KEY}.json`),
  );
  for (const { init } of fetched) {
    expect(init).toEqual({
      method: "GET",
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { "200-299": 31_536_000, "300-599": -1 },
      },
    });
  }
});
