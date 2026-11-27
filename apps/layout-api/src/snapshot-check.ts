import type { Issue } from "@brr/schema/decode";
import type { Sha256, ShardSummary, WorldSnapshot } from "@brr/schema/layout-api";
import { compareSuperChunks, referencedImports, shardName } from "@brr/schema/world";

export interface ShardBinding {
  readonly name: string;
  readonly sha256: Sha256;
}

export function shardBindings(snapshot: WorldSnapshot): ReadonlyArray<ShardBinding> {
  return snapshot.manifest.shards.flatMap((entry) => {
    const name = shardName(entry.superChunk);
    const sha256 = snapshot.shards[name];
    return sha256 === undefined ? [] : [{ name, sha256 }];
  });
}

function manifestIssues(
  snapshot: WorldSnapshot,
  summaries: ReadonlyMap<Sha256, ShardSummary>,
): Issue[] {
  return snapshot.manifest.shards.flatMap((entry) => {
    const name = shardName(entry.superChunk);
    const path = `snapshot.shards.${name}`;
    const sha256 = snapshot.shards[name];
    const summary = sha256 === undefined ? undefined : summaries.get(sha256);
    if (summary === undefined) return [];
    const issues: Issue[] = [];
    if (compareSuperChunks(summary.superChunk, entry.superChunk) !== 0) {
      issues.push({ path, message: `holds super-chunk ${shardName(summary.superChunk)}` });
    }
    if (summary.placements !== entry.placements) {
      issues.push({
        path,
        message: `holds ${summary.placements} placements, the manifest says ${entry.placements}`,
      });
    }
    if (summary.track !== entry.track) {
      issues.push({
        path,
        message: `holds ${summary.track} track pieces, the manifest says ${entry.track}`,
      });
    }
    return issues;
  });
}

function trackIssues(
  bindings: ReadonlyArray<ShardBinding>,
  summaries: ReadonlyMap<Sha256, ShardSummary>,
): Issue[] {
  const indices = bindings
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
  bindings: ReadonlyArray<ShardBinding>,
  summaries: ReadonlyMap<Sha256, ShardSummary>,
): Issue[] {
  const referenced = new Set<string>([
    ...bindings.flatMap((binding) => summaries.get(binding.sha256)?.imports ?? []),
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
  const bindings = shardBindings(snapshot);
  return [
    ...manifestIssues(snapshot, summaries),
    ...trackIssues(bindings, summaries),
    ...importIssues(snapshot, bindings, summaries),
  ];
}
