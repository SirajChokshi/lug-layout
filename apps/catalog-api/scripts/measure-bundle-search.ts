import { BundleSearchResponse } from "@brr/schema/catalog-api";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";

type Phase = "miss" | "hit" | "revalidate";

interface Sample {
  readonly query: string;
  readonly phase: Phase;
  readonly status: number;
  readonly cache: string | null;
  readonly ms: number;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly results: number | null;
}

const MISS_LIMITS = { first: 20, last: 50 } as const;
const defaultQueries = ["3811", "10264", "crossroads", "tan", "mils road", "4219692"];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "http://127.0.0.1:8787" },
      manifest: { type: "string" },
      rounds: { type: "string", default: "30" },
      query: { type: "string", multiple: true },
    },
  });
  if (values.manifest === undefined) {
    throw new Error("Usage: measure-bundle-search --manifest <16-hex key> [--base url]");
  }
  const queries = values.query ?? defaultQueries;
  const rounds = Number(values.rounds);
  const searchUrl = (q: string, limit: number) =>
    `${values.base}/v1/bundles/${values.manifest}/search?${new URLSearchParams({ q, limit: String(limit) }).toString()}`;
  const coldIndex = await sample("cold index", "miss", searchUrl("baseplate", 1), {});
  const samples: Sample[] = [];
  for (const query of queries) {
    for (let pass = 0; pass < rounds; pass += 1) {
      const limit = MISS_LIMITS.first + (pass % (MISS_LIMITS.last - MISS_LIMITS.first + 1));
      const fresh = pass < MISS_LIMITS.last - MISS_LIMITS.first + 1;
      if (fresh) samples.push(await sample(query, "miss", searchUrl(query, limit), {}));
      samples.push(await sample(query, "hit", searchUrl(query, MISS_LIMITS.first), {}));
      samples.push(
        await sample(query, "revalidate", searchUrl(query, MISS_LIMITS.first), {
          "if-none-match": `"${values.manifest}"`,
        }),
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        manifest: values.manifest,
        coldIndex,
        overall: summarize(samples, (entry) => entry.phase),
        perQuery: summarize(samples, (entry) => `${entry.query} ${entry.phase}`),
      },
      null,
      2,
    )}\n`,
  );
}

let client = 0;

async function sample(
  query: string,
  phase: Phase,
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<Sample> {
  client += 1;
  const started = performance.now();
  const response = await fetch(url, {
    headers: { "cf-connecting-ip": `203.0.113.${client % 250}`, ...headers },
  });
  const body = new Uint8Array(await response.arrayBuffer());
  const ms = performance.now() - started;
  const results =
    response.status === 200
      ? decodedOrThrow(
          decode(BundleSearchResponse, JSON.parse(new TextDecoder().decode(body))),
          url,
        ).results.length
      : null;
  return {
    query,
    phase,
    status: response.status,
    cache: response.headers.get("x-cache"),
    ms,
    bytes: body.byteLength,
    gzipBytes: body.byteLength === 0 ? 0 : gzipSync(body).byteLength,
    results,
  };
}

function summarize(
  samples: ReadonlyArray<Sample>,
  groupOf: (entry: Sample) => string,
): ReadonlyArray<Record<string, unknown>> {
  const groups = new Map<string, Sample[]>();
  for (const entry of samples) {
    groups.set(groupOf(entry), [...(groups.get(groupOf(entry)) ?? []), entry]);
  }
  return [...groups.entries()].map(([group, entries]) => {
    const ms = entries.map((entry) => entry.ms).toSorted((a, b) => a - b);
    const bytes = entries.map((entry) => entry.bytes).toSorted((a, b) => a - b);
    const gzip = entries.map((entry) => entry.gzipBytes).toSorted((a, b) => a - b);
    return {
      group,
      n: entries.length,
      statuses: [...new Set(entries.map((entry) => `${entry.status}/${entry.cache ?? "-"}`))].join(
        " ",
      ),
      p50Ms: round(quantile(ms, 0.5)),
      p95Ms: round(quantile(ms, 0.95)),
      bytesP50: quantile(bytes, 0.5),
      gzipBytesP50: quantile(gzip, 0.5),
      resultsP50: quantile(
        entries
          .flatMap((entry) => (entry.results === null ? [] : [entry.results]))
          .toSorted((a, b) => a - b),
        0.5,
      ),
    };
  });
}

function quantile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

await main();
