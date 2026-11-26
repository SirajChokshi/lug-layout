import { LINK_PROGRESS_SHARE } from "@brr/catalog";
import { BUNDLE_POINTER_FILE } from "@brr/schema/bundle-pointer";
import type { BundleSearchHit } from "@brr/schema/catalog-api";
import { Container } from "inversify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import type { CatalogItemView } from "./placeable-catalog.ts";
import { CATALOG_SEARCH } from "../tokens.ts";
import type { ICatalogSearch } from "./catalog-search.ts";
import { PaletteIndex } from "./palette-index.ts";
import { paletteResults } from "./palette-results.ts";
import { silentPeers } from "./silent-peers.test-support.ts";

const workerBase = "https://catalog.test";
const bundleBase = "https://bundle.test";
const manifestKey = "7ad9e66acd1f7b18";
const keyedManifest = `manifest.${manifestKey}.json`;
const fallbackManifest = "manifest.0123456789abcdef.json";
const TAN = { code: 19, name: "Tan", rgb: "#E4CD9E" };
const GREEN = { code: 2, name: "Green", rgb: "#237841" };

function baseplate(color: CatalogItemView["color"] & object): CatalogItemView {
  return {
    id: `ldraw:3811@${color.code}`,
    label: `3811 Baseplate 32 x 32, ${color.name}`,
    group: "ldraw:3811",
    shortLabel: "3811 32×32",
    groupLabel: "3811 Baseplate 32 x 32",
    color,
    kind: "baseplate",
    parts: 1,
    studsWide: 32,
    studsDeep: 32,
    thumbnail: null,
    aliases: [],
    elements: [],
    displayColor: false,
    draggable: true,
    toggleable: false,
    listedUnder: null,
    customParts: 0,
  };
}

const crossroads: CatalogItemView = {
  id: "ldraw:2358p02@72",
  label: "2358p02 Baseplate 48 x 48 Road Crossroads, Dark_Bluish_Grey",
  group: "ldraw:2358p02",
  shortLabel: "2358p02 48×48",
  groupLabel: "2358p02 Baseplate 48 x 48 Road Crossroads",
  color: { code: 72, name: "Dark_Bluish_Grey", rgb: "#6C6E68" },
  kind: "road-plate",
  parts: 1,
  studsWide: 48,
  studsDeep: 48,
  thumbnail: null,
  aliases: [],
  elements: [],
  displayColor: false,
  draggable: true,
  toggleable: false,
  listedUnder: null,
  customParts: 0,
};

const index = new PaletteIndex([baseplate(TAN), baseplate(GREEN), crossroads]);

function workerHit(id: string, section: BundleSearchHit["section"]): BundleSearchHit {
  return {
    id,
    label: id,
    section,
    kind: section === "road" ? "road-plate" : "baseplate",
    file: `shape-${id}.json`,
  };
}

interface Served {
  readonly requests: string[];
}

function pointerResponse(url: URL, pointedManifest: string | null): Response {
  return url.pathname === `/${BUNDLE_POINTER_FILE}` && pointedManifest !== null
    ? new Response(JSON.stringify({ manifestFile: pointedManifest }))
    : new Response("not found", { status: 404 });
}

function serveWorker(
  answer: (url: URL) => Response | Promise<Response>,
  pointedManifest: string | null = keyedManifest,
): Served {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input);
    if (url.origin === bundleBase) return pointerResponse(url, pointedManifest);
    requests.push(input);
    return answer(url);
  });
  return { requests };
}

function catalogSearchWith(config: {
  readonly manifestFile?: string;
  readonly baseUrl?: string;
}): ICatalogSearch {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: `${bundleBase}/`,
      disclaimer: "unused",
      ...(config.manifestFile === undefined ? {} : { bundleManifestFile: config.manifestFile }),
      ...(config.baseUrl === undefined ? {} : { catalogApiBaseUrl: config.baseUrl }),
    }),
  );
  container.rebind(LINK_PROGRESS_SHARE).toConstantValue(silentPeers);
  return container.get(CATALOG_SEARCH);
}

async function typeAndSettle(search: ICatalogSearch, typed: string): Promise<void> {
  for (let end = 1; end <= typed.length; end++) {
    search.search(typed.slice(0, end));
    await vi.advanceTimersByTimeAsync(40);
  }
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("palette search through the catalog Worker", () => {
  it("asks the Worker once per settled query for the manifest current/latest.json names, and merges its hits after the local ones", async () => {
    const served = serveWorker(
      (url) =>
        new Response(
          JSON.stringify({
            manifest: manifestKey,
            query: url.searchParams.get("q"),
            results: [
              workerHit("ldraw:3811@19", "baseplates"),
              workerHit("ldraw:2358p02@72", "road"),
              workerHit("ldraw:3811@2", "baseplates"),
              workerHit("ldraw:44336p03@72", "road"),
            ],
          }),
        ),
    );
    const search = catalogSearchWith({ manifestFile: fallbackManifest, baseUrl: `${workerBase}/` });

    await typeAndSettle(search, "tan 32");

    expect(served.requests).toEqual([
      `${workerBase}/v1/bundles/${manifestKey}/search?q=tan+32&limit=50`,
    ]);
    const results = paletteResults(index, "tan 32", "all", search.view());
    expect(results.status).toBe("ready");
    expect(results.hits.map((hit) => [hit.entry.key, hit.items.map((item) => item.id)])).toEqual([
      ["ldraw:3811", ["ldraw:3811@19", "ldraw:3811@2"]],
      ["ldraw:2358p02", ["ldraw:2358p02@72"]],
    ]);
    expect(results.remoteOnly.map((hit) => hit.id)).toEqual(["ldraw:44336p03@72"]);
    expect(results.counts.get("all")).toBe(2);
    expect(results.counts.get("road")).toBe(1);
    const road = paletteResults(index, "tan 32", "road", search.view());
    expect(road.hits.map((hit) => hit.entry.key)).toEqual(["ldraw:2358p02"]);
  });

  it("keeps local ranking and reports offline when the Worker cannot answer", async () => {
    for (const failure of [
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => new Response(JSON.stringify({ error: "rate limit exceeded" }), { status: 429 }),
      () => new Response(JSON.stringify({ manifest: manifestKey, query: "tan", results: "?" })),
    ]) {
      serveWorker(failure);
      const search = catalogSearchWith({ manifestFile: keyedManifest, baseUrl: workerBase });
      await typeAndSettle(search, "tan");
      const results = paletteResults(index, "tan", "all", search.view());
      expect(results.status).toBe("offline");
      expect(results.hits.map((hit) => hit.items.map((item) => item.id))).toEqual([
        ["ldraw:3811@19"],
      ]);
    }
  });

  it("never asks the Worker for short queries, without a base URL, or for an unkeyed manifest", async () => {
    const served = serveWorker(() => Promise.reject(new Error("no request expected")), null);
    const cases = [
      {
        search: catalogSearchWith({ manifestFile: keyedManifest, baseUrl: workerBase }),
        typed: " ta ",
      },
      { search: catalogSearchWith({ manifestFile: keyedManifest }), typed: "tan" },
      { search: catalogSearchWith({ baseUrl: workerBase }), typed: "tan" },
    ];
    for (const { search, typed } of cases) await typeAndSettle(search, typed);
    expect(served.requests).toEqual([]);
    expect(cases.map(({ search }) => search.view().status)).toEqual(["idle", "off", "off"]);
  });
});
