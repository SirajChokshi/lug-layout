import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RELEASE_ID_HEX_DIGITS,
  ErrorResponse,
  InventoryResponse,
  ReleaseResponse,
  SearchResponse,
  ThemePageResponse,
  ThemeRootsResponse,
} from "@brr/schema/catalog-api";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import type * as v from "valibot";
import { createTestHarness, type TestHarness } from "wrangler";
import { releaseCounts, releaseProblems, releaseStatements } from "../scripts/release-sql.ts";
import { CURRENT_RELEASE_TABLE, releaseObjectKey } from "./release-schema.ts";

interface PreparedStatement {
  first<T>(): Promise<T | null>;
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

const syntheticModule =
  "INSERT INTO sets(id, set_num, name, year, theme_id, num_parts, kind, author) VALUES (27326, 'mod-000001', 'Riverside Fire Station', 2020, 58, 500, 1, 'brickfan')";

const laterSet =
  "INSERT INTO sets(id, set_num, name, year, theme_id, num_parts, kind) VALUES (14082, '60110-1', 'Fire Station', 2016, 58, 919, 0)";

let server: TestHarness;
let scratch: string;
let current: LoadedRelease;
let staged: LoadedRelease;
let currentPath: string;
let bindings: TestEnv;

const QUERIES_PER_MINUTE = 100;

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
  const id = sha256.slice(0, RELEASE_ID_HEX_DIGITS);
  const source = new DatabaseSync(path, { readOnly: true });
  const statements = [
    ...releaseStatements(
      source,
      {
        id,
        sha256,
        bytes: bytes.byteLength,
        object_key: releaseObjectKey(id),
        source: "rebrickable-db@ad9943cc slice",
        loaded_at: "2026-11-16T00:00:00.000Z",
        counts: JSON.stringify(releaseCounts(source)),
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

function wrangler(args: ReadonlyArray<string>): string {
  const result = spawnSync(join(packageRoot, "node_modules", ".bin", "wrangler"), args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  return result.stdout;
}

async function getJson<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
): Promise<v.InferOutput<Schema>> {
  const response = await get(path);
  expect(response.status).toBe(200);
  return decodedOrThrow(decode(schema, await response.json()), path);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "catalog-api-"));
  server = createTestHarness({
    root: packageRoot,
    workers: [{ configPath: "./wrangler.json" }],
  });
  await server.listen();
  bindings = await server.getWorker<TestEnv>().getEnv();
  currentPath = await buildRelease("current.sqlite", []);
  current = await loadRelease(bindings, currentPath, true);
  staged = await loadRelease(bindings, await buildRelease("staged.sqlite", [laterSet]), false);
}, 60_000);

afterAll(async () => {
  await server.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("catalog API over a loaded release", () => {
  it("points current at the promoted release and redirects unversioned paths to it", async () => {
    const body = await getJson(ReleaseResponse, "/v1/catalogs/current");
    expect(body.release.id).toBe(current.id);
    expect(body.release.sha256).toBe(current.sha256);
    expect(body.release.counts).toMatchObject({ sets: 3, themes: 4, inventoryLots: 6 });
    const redirect = await get("/v1/catalogs/current/search?q=fire");
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe(
      `http://catalog.test/v1/catalogs/${current.id}/search?q=fire`,
    );
  });

  it("matches whole words and a last word of 3 or more letters as a prefix", async () => {
    const typed = await getJson(SearchResponse, `/v1/catalogs/${current.id}/search?q=fire%20sta`);
    expect(typed.results.set?.map((set) => set.id).toSorted()).toEqual(["60004-1", "60215-1"]);
    expect(typed.results.part).toEqual([]);
    const shortLast = await getJson(
      SearchResponse,
      `/v1/catalogs/${current.id}/search?q=fire%20st&kind=set`,
    );
    expect(shortLast.results.set).toEqual([]);
    const threeLetters = await getJson(
      SearchResponse,
      `/v1/catalogs/${current.id}/search?q=fir&kind=set`,
    );
    expect(threeLetters.results.set).toHaveLength(2);
    const train = await getJson(
      SearchResponse,
      `/v1/catalogs/${current.id}/search?q=9v%20metro&kind=set`,
    );
    expect(train.results.set?.map((set) => [set.id, set.theme?.path])).toEqual([
      ["4558-1", "Train > 9V"],
    ]);
    const parts = await getJson(
      SearchResponse,
      `/v1/catalogs/${current.id}/search?q=PLATE%201&kind=part`,
    );
    expect(parts.results.part).toEqual([{ id: "3024", name: "Plate 1 x 1", category: "Plates" }]);
    const byNumber = await getJson(
      SearchResponse,
      `/v1/catalogs/${current.id}/search?q=3010&kind=part`,
    );
    expect(byNumber.results.part?.map((part) => part.id)).toEqual(["3010"]);
    const modules = await getJson(
      SearchResponse,
      `/v1/catalogs/${current.id}/search?q=fire&kind=module`,
    );
    expect(modules.results.module).toEqual([]);
  });

  it("rejects queries shorter than 3 characters after trimming", async () => {
    for (const q of ["a", "ab", "%20%20ab%20", "%20%20%20%20", "x%20", ""]) {
      const response = await get(`/v1/catalogs/${current.id}/search?q=${q}`);
      expect({ q, status: response.status }).toEqual({ q, status: 400 });
      expect(decode(ErrorResponse, await response.json())).toEqual({
        ok: true,
        value: { error: "query.q: must be at least 3 characters after trimming spaces" },
      });
    }
    expect((await get(`/v1/catalogs/${current.id}/search?q=%20a%20b%20`)).status).toBe(200);
  });

  it("returns a set inventory with colors, spares and minifigs", async () => {
    const body = await getJson(
      InventoryResponse,
      `/v1/catalogs/${current.id}/sets/60215-1/inventory`,
    );
    expect(body.set.theme?.path).toBe("City > Fire");
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
    const roots = await getJson(ThemeRootsResponse, `/v1/catalogs/${current.id}/themes`);
    expect(roots.themes.map((theme) => [theme.name, theme.setCount])).toEqual([
      ["City", 2],
      ["Train", 1],
    ]);
    const city = await getJson(ThemePageResponse, `/v1/catalogs/${current.id}/themes/52?limit=1`);
    expect(city.children.map((child) => [child.id, child.setCount])).toEqual([[58, 2]]);
    expect(city.sets.map((set) => set.id)).toEqual(["60215-1"]);
    expect(city.page.total).toBe(2);
    expect(city.page.next).toBe(
      `http://catalog.test/v1/catalogs/${current.id}/themes/52?limit=1&offset=1`,
    );
  });

  it("serves a staged release at its own id without moving current", async () => {
    const before = await getJson(SearchResponse, fireSetSearch(current.id));
    const after = await getJson(SearchResponse, fireSetSearch(staged.id));
    expect(before.results.set).toHaveLength(2);
    expect(after.results.set?.map((set) => set.id)).toContain("60110-1");
    const pointer = await getJson(ReleaseResponse, "/v1/catalogs/current");
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

  it("streams the release SQLite file from R2 with byte ranges and preconditions", async () => {
    const path = `/v1/catalogs/${staged.id}/catalog.sqlite`;
    const head = await get(path, { range: "bytes=0-15" });
    expect(head.status).toBe(206);
    expect(head.headers.get("x-content-sha256")).toBe(staged.sha256);
    expect(head.headers.get("content-range")).toMatch(/^bytes 0-15\/\d+$/);
    expect(Buffer.from(await head.arrayBuffer()).toString("latin1")).toBe("SQLite format 3\0");
    const size = (await readFile(join(scratch, "staged.sqlite"))).byteLength;
    const beyond = await get(path, { range: `bytes=${size}-` });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${size}`);
    const mismatch = await get(path, { "if-match": '"not-this-file"' });
    expect(mismatch.status).toBe(412);
    const full = await get(path);
    expect(
      createHash("sha256")
        .update(Buffer.from(await full.arrayBuffer()))
        .digest("hex"),
    ).toBe(staged.sha256);
    expect(full.headers.get("x-cache")).toBe("MISS");
    const again = await get(path);
    await again.arrayBuffer();
    expect(again.headers.get("x-cache")).toBe("HIT");
  });

  it("keeps the current pointer when the current release is reloaded without promotion", async () => {
    await loadRelease(bindings, currentPath, false);
    const pointer = await bindings.CATALOG_DB.prepare(
      `SELECT release_id FROM ${CURRENT_RELEASE_TABLE} WHERE slot = 'current'`,
    ).first<{ release_id: string }>();
    expect(pointer?.release_id).toBe(current.id);
  });

  it("refuses releases that contain module rows", async () => {
    const path = await buildRelease("with-module.sqlite", [syntheticModule]);
    const source = new DatabaseSync(path, { readOnly: true });
    expect(releaseProblems(source)).toEqual([
      "release has 1 module rows; modules are refused until the release build imports real module data",
    ]);
    source.close();
  });

  it("loads a release through the CLI into local D1 and R2 by file import", () => {
    const state = join(scratch, "state");
    const output = spawnSync(
      process.execPath,
      [
        "scripts/load-release.ts",
        "--sqlite",
        currentPath,
        "--source",
        "rebrickable-db@ad9943cc slice",
        "--local",
        "--persist-to",
        state,
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );
    expect({ status: output.status, stderr: output.stderr }).toMatchObject({ status: 0 });
    const rows = JSON.parse(
      wrangler([
        "d1",
        "execute",
        "CATALOG_DB",
        "--local",
        "--persist-to",
        state,
        "--json",
        "--command",
        `SELECT c.release_id, s.set_num FROM r${current.id}_sets_fts JOIN r${current.id}_sets s ON s.id = r${current.id}_sets_fts.rowid JOIN ${CURRENT_RELEASE_TABLE} c WHERE r${current.id}_sets_fts MATCH '{kind} : "set" AND {name theme} : ("metro"*)'`,
      ]),
    ) as Array<{ results: Array<{ release_id: string; set_num: string }> }>;
    expect(rows[0]?.results).toEqual([{ release_id: current.id, set_num: "4558-1" }]);
    const header = wrangler([
      "r2",
      "object",
      "get",
      `brr-catalog-releases/${releaseObjectKey(current.id)}`,
      "--local",
      "--persist-to",
      state,
      "--pipe",
    ]);
    expect(header.startsWith("SQLite format 3")).toBe(true);
  }, 60_000);

  it("rejects malformed queries and rate-limits a client's uncached queries", async () => {
    expect((await get(`/v1/catalogs/${current.id}/search?q=fire&limit=500`)).status).toBe(400);
    expect((await get(`/v1/catalogs/${current.id}/search?q=fire&kind=train`)).status).toBe(400);
    const burst = async (client: string) => {
      const statuses: number[] = [];
      let retryAfter: string | null = null;
      for (let index = 0; index <= 2 * QUERIES_PER_MINUTE && retryAfter === null; index += 1) {
        const response = await get(`/v1/catalogs/${current.id}/search?q=${client}x${index}`, {
          "cf-connecting-ip": client,
        });
        await response.arrayBuffer();
        statuses.push(response.status);
        retryAfter = response.headers.get("retry-after");
      }
      return { allowed: statuses.indexOf(429), statuses: new Set(statuses), retryAfter };
    };
    const bursts = [await burst("192.0.2.98"), await burst("192.0.2.99")];
    expect(bursts.map(({ statuses }) => statuses)).toEqual([
      new Set([200, 429]),
      new Set([200, 429]),
    ]);
    expect(bursts.map(({ retryAfter }) => retryAfter)).toEqual(["60", "60"]);
    expect(Math.min(...bursts.map(({ allowed }) => allowed))).toBeGreaterThanOrEqual(
      QUERIES_PER_MINUTE,
    );
    expect(bursts.map(({ allowed }) => allowed)).toContain(QUERIES_PER_MINUTE);
  }, 60_000);
});
