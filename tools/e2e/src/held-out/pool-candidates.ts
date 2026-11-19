import { LdrawMirror, type FetchFunction } from "@brr/import";
import { bundlePartGlb, type BundleParts } from "./bundle.ts";
import { isPoolCandidate, needsLdrawText, type PoolCandidate } from "./generator.ts";
import { partExtras } from "./part-connectors.ts";

const STUD_TOP_Y = 7;

export async function poolCandidates(
  bundle: BundleParts,
  fetchUrl: FetchFunction,
): Promise<PoolCandidate[]> {
  const mirror = new LdrawMirror(bundle.source, fetchUrl);
  const candidates: PoolCandidate[] = [];
  for (const part of bundle.parts.values()) {
    if (!isPoolCandidate(part.title)) continue;
    const extras = partExtras(await bundlePartGlb(bundle, part), part.id);
    candidates.push({
      part,
      studTopsY: extras.studs.map((stud) => stud.matrix[STUD_TOP_Y] ?? 0),
      ldrawText: needsLdrawText(part.title) ? ((await mirror.file(part.path)) ?? null) : null,
    });
  }
  return candidates;
}
