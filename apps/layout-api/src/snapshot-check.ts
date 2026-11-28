import type { Issue } from "@brr/schema/decode";
import type { Sha256, ShardSummary, WorldSnapshot } from "@brr/schema/layout-api";
import {
  compareSuperChunks,
  referencedImports,
  shardName,
  type SuperChunk,
} from "@brr/schema/world";

interface ShardCounts {
  readonly superChunk: SuperChunk;
  readonly placements: number;
  readonly track: number;
  readonly notes: number;
}

export interface ShardBinding {
  readonly path: string;
  readonly sha256: Sha256;
  readonly expected: ShardCounts;
}

function bindings(
  entries: ReadonlyArray<ShardCounts>,
  hashes: Readonly<Record<string, Sha256>>,
  field: "shards" | "notes",
): ShardBinding[] {
  return entries.flatMap((expected) => {
    const name = shardName(expected.superChunk);
    const sha256 = hashes[name];
    return sha256 === undefined ? [] : [{ path: `snapshot.${field}.${name}`, sha256, expected }];
  });
}

export function shardBindings(snapshot: WorldSnapshot): ReadonlyArray<ShardBinding> {
  const { manifest } = snapshot;
  return [
    ...bindings(
      manifest.shards.map((entry) => ({ ...entry, notes: 0 })),
      snapshot.shards,
      "shards",
    ),
    ...bindings(
      manifest.noteShards.map((entry) => ({ ...entry, placements: 0, track: 0 })),
      snapshot.notes,
      "notes",
    ),
  ];
}

const COUNTED = [
  ["placements", "placements"],
  ["track", "track pieces"],
  ["notes", "notes"],
] as const;

function manifestIssues(
  shards: ReadonlyArray<ShardBinding>,
  summaries: ReadonlyMap<Sha256, ShardSummary>,
): Issue[] {
  return shards.flatMap(({ path, sha256, expected }) => {
    const summary = summaries.get(sha256);
    if (summary === undefined) return [];
    const issues: Issue[] = [];
    if (compareSuperChunks(summary.superChunk, expected.superChunk) !== 0) {
      issues.push({ path, message: `holds super-chunk ${shardName(summary.superChunk)}` });
    }
    for (const [count, noun] of COUNTED) {
      if (summary[count] !== expected[count]) {
        issues.push({
          path,
          message: `holds ${summary[count]} ${noun}, the manifest says ${expected[count]}`,
        });
      }
    }
    return issues;
  });
}

function trackIssues(
  shards: ReadonlyArray<ShardBinding>,
  summaries: ReadonlyMap<Sha256, ShardSummary>,
): Issue[] {
  const indices = shards
    .flatMap((binding) => summaries.get(binding.sha256)?.trackIndices ?? [])
    .toSorted((a, b) => a - b);
  if (indices.every((index, position) => index === position)) return [];
  return [
    {
      path: "snapshot.shards",
      message: "the shards' track indices must run 0, 1, 2, … once each",
    },
  ];
}

function importIssues(
  snapshot: WorldSnapshot,
  shards: ReadonlyArray<ShardBinding>,
  summaries: ReadonlyMap<Sha256, ShardSummary>,
): Issue[] {
  const referenced = new Set<string>([
    ...shards.flatMap((binding) => summaries.get(binding.sha256)?.imports ?? []),
    ...referencedImports([], snapshot.manifest.consists ?? []),
  ]);
  const listed = new Set(snapshot.imports.map((entry) => entry.sha256));
  const unlisted = [...referenced].filter((sha256) => !listed.has(sha256)).toSorted();
  const unreferenced = [...listed].filter((sha256) => !referenced.has(sha256));
  return [
    ...unlisted.map((sha256) => ({
      path: "snapshot.imports",
      message: `is missing ${sha256}, the original file the world places as import:${sha256}`,
    })),
    ...unreferenced.map((sha256) => ({
      path: "snapshot.imports",
      message: `lists ${sha256}, which nothing in the world places`,
    })),
  ];
}

export function snapshotIssues(
  snapshot: WorldSnapshot,
  summaries: ReadonlyMap<Sha256, ShardSummary>,
): ReadonlyArray<Issue> {
  const shards = shardBindings(snapshot);
  return [
    ...manifestIssues(shards, summaries),
    ...trackIssues(shards, summaries),
    ...importIssues(snapshot, shards, summaries),
  ];
}
