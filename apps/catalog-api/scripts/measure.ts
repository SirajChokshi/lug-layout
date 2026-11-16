import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

interface Sample {
  readonly endpoint: Endpoint;
  readonly phase: "miss" | "hit" | "revalidate";
  readonly url: string;
  readonly status: number;
  readonly cache: string | null;
  readonly ms: number;
  readonly bytes: number;
  readonly rowsRead: number | null;
  readonly d1Ms: number | null;
}

type Endpoint =
  | "search"
  | "search-3-chars"
  | "search-under-3-chars"
  | "inventory"
  | "theme-roots"
  | "theme";

interface Probe {
  readonly endpoint: Endpoint;
  readonly path: string;
}

const anchorSearches = ["fire sta", "train", "3001", "brick 2 x 4", "9v swi", "assembly squ"];
const broadestThreeLetterPrefixes = [
  "pri",
  "wit",
  "and",
  "min",
  "hea",
  "bri",
  "gea",
  "sta",
  "sup",
  "the",
  "set",
  "pac",
];
const underThreeCharacters = ["a", "s", "1", "st", "9v", "  ab  "];
const anchorSets = ["60215-1", "10255-1"];
const anchorThemes = [233, 52];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "http://127.0.0.1:8787" },
      sqlite: { type: "string" },
      samples: { type: "string", default: "100" },
      out: { type: "string" },
      burst: { type: "string", default: "120" },
    },
  });
  if (values.sqlite === undefined) {
    throw new Error(
      "Usage: measure --sqlite <release file> [--base url] [--samples n] [--out file]",
    );
  }
  const perEndpoint = Number(values.samples);
  const current = (await (await fetch(`${values.base}/v1/catalogs/current`)).json()) as {
    release: { id: string };
  };
  const release = current.release.id;
  const probes = plan(new DatabaseSync(resolve(values.sqlite), { readOnly: true }), perEndpoint);
  const samples: Sample[] = [];
  let client = 0;
  for (const probe of probes) {
    client += 1;
    const url = `${values.base}/v1/catalogs/${release}${probe.path}`;
    const miss = await sample(probe.endpoint, "miss", url, clientAddress(client), {});
    if (probe.endpoint === "search-under-3-chars") {
      samples.push(miss);
      continue;
    }
    const hit = await sample(probe.endpoint, "hit", url, clientAddress(client), {});
    const revalidate = await sample(probe.endpoint, "revalidate", url, clientAddress(client), {
      "if-none-match": `"${release}"`,
    });
    samples.push(miss, hit, revalidate);
  }
  const burst = await burstFromOneClient(values.base, release, Number(values.burst));
  const file = await releaseFileChecks(`${values.base}/v1/catalogs/${release}/catalog.sqlite`);
  const summary = summarize(samples);
  if (values.out !== undefined) {
    await writeFile(
      values.out,
      `${samples.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ release, probes: probes.length, summary, burst, file }, null, 2)}\n`,
  );
}

function stride<T>(rows: ReadonlyArray<T>, count: number): ReadonlyArray<T> {
  const step = Math.max(1, Math.floor(rows.length / count));
  return rows.filter((_, index) => index % step === 0).slice(0, count);
}

function plan(db: DatabaseSync, perEndpoint: number): ReadonlyArray<Probe> {
  const words = db
    .prepare("SELECT name FROM sets WHERE kind = 0 ORDER BY id")
    .all()
    .map(
      (row) =>
        String(row["name"])
          .toLowerCase()
          .match(/[\p{L}\p{N}]+/gu) ?? [],
    );
  const setNames = words
    .filter((name) => name.length >= 2 && String(name[1]).length >= 3)
    .map((name) => `${name[0]} ${String(name[1]).slice(0, 3)}`);
  const threeLetterPrefixes = words
    .map((name) => String(name[0] ?? ""))
    .filter((word) => word.length >= 3)
    .map((word) => word.slice(0, 3));
  const inventorySets = db
    .prepare(
      "SELECT s.set_num FROM sets s WHERE EXISTS (SELECT 1 FROM inventory_parts ip WHERE ip.inventory_id = s.id) ORDER BY s.id",
    )
    .all()
    .map((row) => String(row["set_num"]));
  const themes = db
    .prepare("SELECT id FROM themes ORDER BY id")
    .all()
    .map((row) => Number(row["id"]));
  const searches = [...anchorSearches, ...stride(setNames, perEndpoint - anchorSearches.length)];
  const prefixes = [
    ...broadestThreeLetterPrefixes,
    ...stride([...new Set(threeLetterPrefixes)], perEndpoint - broadestThreeLetterPrefixes.length),
  ];
  const sets = [...anchorSets, ...stride(inventorySets, perEndpoint - anchorSets.length)];
  const themeIds = [...anchorThemes, ...stride(themes, perEndpoint - anchorThemes.length)];
  return [
    { endpoint: "theme-roots", path: "/themes" },
    ...[...new Set(searches)].map((query) => ({
      endpoint: "search" as const,
      path: `/search?${new URLSearchParams({ q: query }).toString()}`,
    })),
    ...[...new Set(prefixes)].map((query) => ({
      endpoint: "search-3-chars" as const,
      path: `/search?${new URLSearchParams({ q: query }).toString()}`,
    })),
    ...underThreeCharacters.map((query) => ({
      endpoint: "search-under-3-chars" as const,
      path: `/search?${new URLSearchParams({ q: query }).toString()}`,
    })),
    ...[...new Set(sets)].map((set) => ({
      endpoint: "inventory" as const,
      path: `/sets/${encodeURIComponent(set)}/inventory`,
    })),
    ...[...new Set(themeIds)].map((id) => ({ endpoint: "theme" as const, path: `/themes/${id}` })),
  ];
}

async function sample(
  endpoint: Endpoint,
  phase: Sample["phase"],
  url: string,
  client: string,
  headers: Readonly<Record<string, string>>,
): Promise<Sample> {
  const started = performance.now();
  const response = await fetch(url, { headers: { "cf-connecting-ip": client, ...headers } });
  const body = await response.arrayBuffer();
  const ms = performance.now() - started;
  const rows = response.headers.get("x-d1-rows-read");
  const timing = /d1;dur=([0-9.]+)/.exec(response.headers.get("server-timing") ?? "");
  return {
    endpoint,
    phase,
    url,
    status: response.status,
    cache: response.headers.get("x-cache"),
    ms,
    bytes: body.byteLength,
    rowsRead: rows === null ? null : Number(rows),
    d1Ms: timing?.[1] === undefined ? null : Number(timing[1]),
  };
}

async function releaseFileChecks(url: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const checks: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
    ["full download", {}],
    ["full download again", {}],
    ["range bytes=0-32767", { range: "bytes=0-32767" }],
    ["range past the end", { range: "bytes=999999999-" }],
  ];
  const results: Array<Record<string, unknown>> = [];
  for (const [label, headers] of checks) {
    const started = performance.now();
    const response = await fetch(url, {
      headers: { "cf-connecting-ip": "198.51.100.2", ...headers },
    });
    const body = await response.arrayBuffer();
    results.push({
      label,
      status: response.status,
      cache: response.headers.get("x-cache"),
      ms: round(performance.now() - started),
      bytes: body.byteLength,
    });
  }
  return results;
}

async function burstFromOneClient(
  base: string,
  release: string,
  count: number,
): Promise<Readonly<Record<string, number>>> {
  const statuses: Record<string, number> = {};
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(`${base}/v1/catalogs/${release}/search?q=burst${index}`, {
      headers: { "cf-connecting-ip": "198.51.100.1" },
    });
    await response.arrayBuffer();
    statuses[response.status] = (statuses[response.status] ?? 0) + 1;
  }
  return statuses;
}

function summarize(samples: ReadonlyArray<Sample>): ReadonlyArray<Record<string, unknown>> {
  const groups = new Map<string, Sample[]>();
  for (const entry of samples) {
    const key = `${entry.endpoint} ${entry.phase}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const ms = group.map((entry) => entry.ms).toSorted((a, b) => a - b);
    const rows = group.flatMap((entry) => (entry.rowsRead === null ? [] : [entry.rowsRead]));
    const bytes = group.map((entry) => entry.bytes).toSorted((a, b) => a - b);
    return {
      group: key,
      n: group.length,
      statuses: [...new Set(group.map((entry) => `${entry.status}/${entry.cache ?? "-"}`))].join(
        " ",
      ),
      p50Ms: round(quantile(ms, 0.5)),
      p95Ms: round(quantile(ms, 0.95)),
      maxMs: round(ms[ms.length - 1] ?? 0),
      rowsReadP50:
        rows.length === 0
          ? null
          : quantile(
              rows.toSorted((a, b) => a - b),
              0.5,
            ),
      rowsReadMax: rows.length === 0 ? null : Math.max(...rows),
      bytesP50: quantile(bytes, 0.5),
    };
  });
}

function quantile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function clientAddress(index: number): string {
  return `203.0.113.${index % 250}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

await main();
