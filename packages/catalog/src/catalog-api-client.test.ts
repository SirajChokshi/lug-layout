import { Container } from "inversify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogModule } from "./catalog.module.ts";
import { CATALOG_API, CATALOG_API_BASE_URL } from "./tokens.ts";

const base = "https://catalog.test";
const release = "0183623679c09ed2";
const releaseUrl = `${base}/v1/catalogs/${release}`;

const fireStation = {
  id: "60215-1",
  kind: "set",
  name: "Fire Station",
  year: 2019,
  numParts: 510,
  theme: { id: 58, path: "City > Fire", href: `${releaseUrl}/themes/58` },
  author: null,
  footprint: null,
  tags: [],
  href: `${releaseUrl}/sets/60215-1/inventory`,
};

const inventory = {
  release,
  set: { ...fireStation, description: null },
  totals: { lots: 1, parts: 1, spareLots: 0, minifigs: 1 },
  lots: [
    {
      part: { id: "3010", name: "Brick 1 x 4" },
      color: { id: 4, name: "Red", rgb: "C91A09", isTransparent: false },
      quantity: 1,
      isSpare: false,
    },
  ],
  minifigs: [
    {
      id: "fig-008085",
      name: "Fireman, Bright Light Orange Fire Suit, Red Helmet, Orange Life Vest, Orange Sunglasses",
      numParts: 5,
      quantity: 1,
    },
  ],
};

interface Served {
  readonly status: number;
  readonly body: unknown;
}

async function catalogApi(served: Readonly<Record<string, Served>>) {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url);
    const response = served[url];
    if (response === undefined) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(response.body), { status: response.status });
  });
  const container = new Container();
  await container.load(catalogModule);
  container.bind(CATALOG_API_BASE_URL).toConstantValue(`${base}/`);
  return { api: container.get(CATALOG_API), requested };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpCatalogApi", () => {
  it("returns a set inventory that matches the shared contract", async () => {
    const url = `${releaseUrl}/sets/60215-1/inventory`;
    const { api } = await catalogApi({ [url]: { status: 200, body: inventory } });
    const result = await api.inventory(release, "60215-1");
    expect(result.set.theme?.path).toBe("City > Fire");
    expect(result.lots.map((lot) => [lot.part.id, lot.color.name])).toEqual([["3010", "Red"]]);
  });

  it("rejects a response that drifts from the contract, naming the field", async () => {
    const url = `${releaseUrl}/sets/60215-1/inventory`;
    const { totals: _dropped, ...withoutTotals } = inventory;
    const { api } = await catalogApi({ [url]: { status: 200, body: withoutTotals } });
    await expect(api.inventory(release, "60215-1")).rejects.toThrow(`${url}: $.totals:`);
  });

  it("refuses a query under 3 characters without calling the server", async () => {
    const { api, requested } = await catalogApi({});
    await expect(api.search(release, { q: " ab " })).rejects.toThrow(
      "search parameters: query.q: must be at least 3 characters after trimming spaces",
    );
    expect(requested).toEqual([]);
  });

  it("reports the server's error body", async () => {
    const url = `${releaseUrl}/sets/10255-1/inventory`;
    const { api } = await catalogApi({ [url]: { status: 404, body: { error: "no set 10255-1" } } });
    await expect(api.inventory(release, "10255-1")).rejects.toThrow(
      "failed with 404: no set 10255-1",
    );
  });
});
