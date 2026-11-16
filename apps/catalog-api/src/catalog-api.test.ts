import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";
import { releaseStatements } from "../scripts/release-sql.ts";
import { RELEASE_ID_HEX_LENGTH, releaseObjectKey } from "./release-schema.ts";

interface PreparedStatement {
  readonly __brand?: never;
}

interface TestEnv {
  readonly CATALOG_DB: {
    prepare(sql: string): PreparedStatement;
    batch(statements: PreparedStatement[]): Promise<unknown>;
  };
  readonly CATALOG_RELEASES: { put(key: string, value: Uint8Array): Promise<unknown> };
}

interface LoadedRelease {
  readonly id: string;
  readonly sha256: string;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const sourceSchema = [
  "CREATE TABLE themes(id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER, path TEXT NOT NULL)",
  "CREATE TABLE sets(id INTEGER PRIMARY KEY, set_num TEXT NOT NULL UNIQUE, name TEXT NOT NULL, year INTEGER, theme_id INTEGER, num_parts INTEGER, kind INTEGER NOT NULL, author TEXT, description TEXT, tags TEXT, footprint TEXT)",
  "CREATE TABLE colors(id INTEGER PRIMARY KEY, name TEXT NOT NULL, rgb TEXT, is_trans INTEGER)",
  "CREATE TABLE part_categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  "CREATE TABLE parts(id INTEGER PRIMARY KEY, part_num TEXT NOT NULL UNIQUE, name TEXT NOT NULL, cat_id INTEGER, material TEXT)",
  "CREATE TABLE minifigs(id INTEGER PRIMARY KEY, fig_num TEXT NOT NULL UNIQUE, name TEXT NOT NULL, num_parts INTEGER)",
  "CREATE TABLE inventory_parts(inventory_id INTEGER NOT NULL, part_id INTEGER NOT NULL, color_id INTEGER NOT NULL, is_spare INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY(inventory_id, part_id, color_id, is_spare)) WITHOUT ROWID",
  "CREATE TABLE inventory_minifigs(inventory_id INTEGER NOT NULL, minifig_id INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY(inventory_id, minifig_id)) WITHOUT ROWID",
];

const rebrickableSlice = [
  "INSERT INTO themes VALUES (52, 'City', NULL, 'City'), (58, 'Fire', 52, 'City > Fire'), (233, 'Train', NULL, 'Train'), (236, '9V', 233, 'Train > 9V')",
  "INSERT INTO sets(id, set_num, name, year, theme_id, num_parts, kind) VALUES (9267, '4558-1', 'Metroliner', 1991, 236, 789, 0), (13966, '60004-1', 'Fire Station', 2013, 58, 753, 0), (14196, '60215-1', 'Fire Station', 2019, 58, 510, 0)",
  "INSERT INTO colors VALUES (4, 'Red', 'C91A09', 0), (33, 'Trans-Dark Blue', '0020A0', 1), (71, 'Light Bluish Gray', 'A0A5A9', 0)",
  "INSERT INTO part_categories VALUES (11, 'Bricks'), (14, 'Plates')",
  "INSERT INTO parts VALUES (14594, '3010', 'Brick 1 x 4', 11, 'Plastic'), (15372, '3024', 'Plate 1 x 1', 14, 'Plastic')",
  "INSERT INTO minifigs VALUES (7968, 'fig-008085', 'Fireman, Bright Light Orange Fire Suit, Red Helmet, Orange Life Vest, Orange Sunglasses', 5)",
  "INSERT INTO inventory_parts VALUES (14196, 14594, 4, 0, 1), (14196, 14594, 71, 0, 1), (14196, 15372, 4, 0, 2), (14196, 15372, 4, 1, 1), (14196, 15372, 33, 0, 2), (14196, 15372, 33, 1, 1)",
  "INSERT INTO inventory_minifigs VALUES (14196, 7968, 1)",
];

const laterSet =
  "INSERT INTO sets(id, set_num, name, year, theme_id, num_parts, kind) VALUES (14082, '60110-1', 'Fire Station', 2016, 58, 919, 0)";

let server: TestHarness;
let scratch: string;
let current: LoadedRelease;
let staged: LoadedRelease;

async function buildRelease(name: string, extra: ReadonlyArray<string>): Promise<string> {
  const path = join(scratch, name);
  const db = new DatabaseSync(path);
  for (const statement of [...sourceSchema, ...rebrickableSlice, ...extra]) db.exec(statement);
  db.close();
  return path;
}

async function loadRelease(env: TestEnv, path: string, promote: boolean): Promise<LoadedRelease> {
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = sha256.slice(0, RELEASE_ID_HEX_LENGTH);
  const source = new DatabaseSync(path, { readOnly: true });
  const statements = [
    ...releaseStatements(
      source,
      {
        id,
        sha256,
        bytes: bytes.byteLength,
        objectKey: releaseObjectKey(id),
        source: "rebrickable-db@ad9943cc slice",
        loadedAt: "2026-11-16T00:00:00.000Z",
      },
      promote,
    ),
  ];
  source.close();
  await env.CATALOG_RELEASES.put(releaseObjectKey(id), new Uint8Array(bytes));
  await env.CATALOG_DB.batch(statements.map((sql) => env.CATALOG_DB.prepare(sql)));
  return { id, sha256 };
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return server.fetch(`http://catalog.test${path}`, {
    headers: { "cf-connecting-ip": "192.0.2.10", ...headers },
    redirect: "manual",
  });
}

function fireSetSearch(release: string): string {
  return `/v1/catalogs/${release}/search?q=fire&kind=set`;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await get(path);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "catalog-api-"));
  server = createTestHarness({
    root: packageRoot,
    workers: [{ configPath: "./wrangler.json" }],
  });
  await server.listen();
  const env = await server.getWorker<TestEnv>().getEnv();
  current = await loadRelease(env, await buildRelease("current.sqlite", []), true);
  staged = await loadRelease(env, await buildRelease("staged.sqlite", [laterSet]), false);
}, 60_000);

afterAll(async () => {
  await server.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("catalog API over a loaded release", () => {
  it("points current at the promoted release and redirects unversioned paths to it", async () => {
    const body = await getJson<{ release: { id: string; sha256: string; counts: unknown } }>(
      "/v1/catalogs/current",
    );
    expect(body.release.id).toBe(current.id);
    expect(body.release.sha256).toBe(current.sha256);
    expect(body.release.counts).toMatchObject({ sets: 3, themes: 4, inventoryLots: 6 });
    const redirect = await get("/v1/catalogs/current/search?q=fire");
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe(
      `http://catalog.test/v1/catalogs/${current.id}/search?q=fire`,
    );
  });

  it("finds sets by name prefix and theme path, and parts by number and name", async () => {
    const fire = await getJson<{ results: { set: Array<{ id: string }>; part: unknown[] } }>(
      `/v1/catalogs/${current.id}/search?q=fire%20st`,
    );
    expect(fire.results.set.map((set) => set.id).toSorted()).toEqual(["60004-1", "60215-1"]);
    expect(fire.results.part).toEqual([]);
    const train = await getJson<{
      results: { set: Array<{ id: string; theme: { path: string } }> };
    }>(`/v1/catalogs/${current.id}/search?q=9v&kind=set`);
    expect(train.results.set.map((set) => [set.id, set.theme.path])).toEqual([
      ["4558-1", "Train > 9V"],
    ]);
    const parts = await getJson<{ results: { part: Array<{ id: string; category: string }> } }>(
      `/v1/catalogs/${current.id}/search?q=PLATE%201&kind=part`,
    );
    expect(parts.results.part).toEqual([{ id: "3024", name: "Plate 1 x 1", category: "Plates" }]);
    const byNumber = await getJson<{ results: { part: Array<{ id: string }> } }>(
      `/v1/catalogs/${current.id}/search?q=3010&kind=part`,
    );
    expect(byNumber.results.part.map((part) => part.id)).toEqual(["3010"]);
  });

  it("returns a set inventory with colors, spares and minifigs", async () => {
    const body = await getJson<{
      set: { id: string; theme: { path: string } };
      totals: unknown;
      lots: Array<{
        part: { id: string };
        color: { name: string };
        quantity: number;
        isSpare: boolean;
      }>;
      minifigs: Array<{ id: string; quantity: number }>;
    }>(`/v1/catalogs/${current.id}/sets/60215-1/inventory`);
    expect(body.set.theme.path).toBe("City > Fire");
    expect(body.totals).toEqual({ lots: 4, parts: 6, spareLots: 2, minifigs: 1 });
    expect(body.lots[0]).toMatchObject({
      part: { id: "3010" },
      color: { name: "Red" },
      quantity: 1,
      isSpare: false,
    });
    expect(body.minifigs).toEqual([
      {
        id: "fig-008085",
        name: "Fireman, Bright Light Orange Fire Suit, Red Helmet, Orange Life Vest, Orange Sunglasses",
        numParts: 5,
        quantity: 1,
      },
    ]);
    expect((await get(`/v1/catalogs/${current.id}/sets/10255-1/inventory`)).status).toBe(404);
  });

  it("browses a theme subtree newest first with child counts", async () => {
    const roots = await getJson<{ themes: Array<{ name: string; setCount: number }> }>(
      `/v1/catalogs/${current.id}/themes`,
    );
    expect(roots.themes.map((theme) => [theme.name, theme.setCount])).toEqual([
      ["City", 2],
      ["Train", 1],
    ]);
    const city = await getJson<{
      children: Array<{ id: number; setCount: number }>;
      sets: Array<{ id: string }>;
      page: { total: number; next: string | null };
    }>(`/v1/catalogs/${current.id}/themes/52?limit=1`);
    expect(city.children.map((child) => [child.id, child.setCount])).toEqual([[58, 2]]);
    expect(city.sets.map((set) => set.id)).toEqual(["60215-1"]);
    expect(city.page.total).toBe(2);
    expect(city.page.next).toBe(
      `http://catalog.test/v1/catalogs/${current.id}/themes/52?limit=1&offset=1`,
    );
  });

  it("serves a staged release at its own id without moving current", async () => {
    const before = await getJson<{ results: { set: unknown[] } }>(fireSetSearch(current.id));
    const after = await getJson<{ results: { set: Array<{ id: string }> } }>(
      fireSetSearch(staged.id),
    );
    expect(before.results.set).toHaveLength(2);
    expect(after.results.set.map((set) => set.id)).toContain("60110-1");
    const pointer = await getJson<{ release: { id: string } }>("/v1/catalogs/current");
    expect(pointer.release.id).toBe(current.id);
    expect((await get("/v1/catalogs/0000000000000000/themes")).status).toBe(404);
  });

  it("caches versioned responses as immutable and revalidates by release etag", async () => {
    const path = `/v1/catalogs/${current.id}/themes/58`;
    const first = await get(path);
    await first.arrayBuffer();
    expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(first.headers.get("etag")).toBe(`"${current.id}"`);
    expect(first.headers.get("x-cache")).toBe("MISS");
    const second = await get(path);
    await second.arrayBuffer();
    expect(second.headers.get("x-cache")).toBe("HIT");
    const revalidated = await get(path, { "if-none-match": `"${current.id}"` });
    expect(revalidated.status).toBe(304);
  });

  it("streams the release SQLite file from R2 with byte ranges", async () => {
    const response = await get(`/v1/catalogs/${current.id}/catalog.sqlite`, {
      range: "bytes=0-15",
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("x-content-sha256")).toBe(current.sha256);
    expect(response.headers.get("content-range")).toMatch(/^bytes 0-15\/\d+$/);
    expect(Buffer.from(await response.arrayBuffer()).toString("latin1")).toBe("SQLite format 3\0");
  });

  it("rejects malformed queries and rate-limits a client's uncached queries", async () => {
    expect((await get(`/v1/catalogs/${current.id}/search?q=%20%20`)).status).toBe(400);
    expect((await get(`/v1/catalogs/${current.id}/search?q=x&limit=500`)).status).toBe(400);
    const statuses: number[] = [];
    for (let index = 0; index < 101; index += 1) {
      const response = await get(`/v1/catalogs/${current.id}/search?q=limit${index}`, {
        "cf-connecting-ip": "192.0.2.99",
      });
      await response.arrayBuffer();
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(100);
    expect(statuses.at(-1)).toBe(429);
  });
});
