import { decode, type Decoded, type Issue } from "@brr/schema/decode";
import type { ShardSummary } from "@brr/schema/layout-api";
import { WorldShardV1, canonicalJson, parseJsonText, referencedImports } from "@brr/schema/world";
import { sha256Hex } from "./digest.ts";
import { strictUtf8Text } from "./utf8.ts";

const BODY = "body";

export async function hashIssues(
  body: Uint8Array<ArrayBuffer>,
  sha256: string,
): Promise<ReadonlyArray<Issue>> {
  const actual = await sha256Hex(body);
  return actual === sha256 ? [] : [{ path: BODY, message: `hashes to ${actual}, not ${sha256}` }];
}

export function shardSummary(shard: WorldShardV1): ShardSummary {
  return {
    superChunk: shard.superChunk,
    placements: shard.placements.length,
    track: shard.track.length,
    trackIndices: shard.track.map((piece) => piece.index),
    imports: [...referencedImports([shard], [])].toSorted(),
  };
}

export async function readUploadedShard(
  body: Uint8Array<ArrayBuffer>,
  sha256: string,
): Promise<Decoded<ShardSummary>> {
  const mismatch = await hashIssues(body, sha256);
  if (mismatch.length > 0) return { ok: false, issues: mismatch };
  const text = strictUtf8Text(body, BODY);
  if (!text.ok) return text;
  const json = parseJsonText(text.value, BODY);
  if (!json.ok) return json;
  const shard = decode(WorldShardV1, json.value, BODY);
  if (!shard.ok) return shard;
  if (canonicalJson(shard.value) !== text.value) {
    return {
      ok: false,
      issues: [
        {
          path: BODY,
          message:
            "is not the shard's canonical JSON (keys sorted, no whitespace, one trailing newline)",
        },
      ],
    };
  }
  return { ok: true, value: shardSummary(shard.value) };
}
