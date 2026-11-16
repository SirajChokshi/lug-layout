import { readFileSync } from "node:fs";
import { TrackGraph } from "@brr/domain";
import { parseTrackCatalog } from "../../../agent/repos/lug-layout/packages/catalog/src/track-catalog.ts";
import { buildTrackPlan } from "../../../agent/repos/lug-layout/packages/client/src/scene/track-plan.ts";
const root = "/agent/repos/lug-layout/";
const catalog = parseTrackCatalog(JSON.parse(readFileSync(root + "tools/asset-pipeline/dist/bundle/standard/manifest.json", "utf8")).trackCatalog);
const { layout, catalogPieces } = buildTrackPlan(readFileSync(process.argv[3] ?? "/tmp/ev/dogbone.plan", "utf8").trim(), catalog);
const graph = new TrackGraph(layout);
const length = (e: number) => catalogPieces[layout.piece(graph.edgePlacement[e]!)]!.routes[graph.edgeRoute[e]!]!.lengthLdu;
const states = new Uint8Array(graph.switchCount);
const data = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
data.samples.forEach((s: any, i: number) => {
  const pieces = s.trainEdge.map((edge0: number, t: number) => {
    const set = new Set<number>(); let edge = edge0; let covered = s.trainOffsetLdu[t];
    set.add(graph.edgePlacement[edge]!);
    while (covered < 706) { const back = graph.successor(graph.reverse(edge), states); if (back < 0) break; edge = graph.reverse(back); set.add(graph.edgePlacement[edge]!); covered += length(edge); }
    return set;
  });
  const shared: string[] = [];
  for (let a = 0; a < pieces.length; a++) for (let b = a + 1; b < pieces.length; b++) for (const p of pieces[a]) if (pieces[b].has(p)) shared.push(`${a}&${b}@${p}`);
  if (shared.length) console.log(i + 1, s.tick, shared.join(" "));
});
