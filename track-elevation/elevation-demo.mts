import { readFileSync } from "node:fs";
import { attachPose16, conjugateZeta16, pose16, zeta16, zeta16ToStuds, PLATE_LDU } from "@brr/math";
import {
  crossing,
  rampRises,
  riserCourses,
  TrackGraph,
  TrackLayout,
  type TrackPieceSpec,
} from "./src/index.ts";

const geometry = JSON.parse(
  readFileSync(new URL("../../docs/verified-facts/geometry.json", import.meta.url), "utf8"),
);
const ends = geometry.trackEnds.find((t: { part: string }) => t.part === "74746");
const straight: TrackPieceSpec = {
  connectors: ends.relative.map((e: { coefficients: string[]; headingSteps: number }) =>
    pose16(conjugateZeta16(zeta16(e.coefficients.map(BigInt))), -e.headingSteps),
  ),
  routes: [{ from: 0, to: 1 }],
};
const RAIL_TOP_LDU = Number(process.argv[3] ?? 24);
const top = Number(process.argv[2] ?? 15);
const layout = new TrackLayout([straight]);

function run(startX: bigint, startZ: bigint, heading: number, rises: ReadonlyArray<number>): number[] {
  const laid: number[] = [];
  let height = 0;
  rises.forEach((rise, i) => {
    const previous = laid[i - 1];
    const target =
      previous === undefined
        ? pose16(zeta16([startX, 0n, 0n, 0n, startZ, 0n, 0n, 0n]), heading)
        : layout.connectorPose(previous, 1);
    const placement = attachPose16(straight.connectors[0] ?? target, target);
    laid.push(layout.place(0, placement, height, rise));
    height += rise;
  });
  return laid;
}

const climb = rampRises(0, top, Array(top).fill(true), 1);
const descend = rampRises(top, 0, Array(top).fill(true), 1);
if (!climb || !descend) throw new Error("no ramp");
const lower = run(48n, 0n, 8, Array(6).fill(0));
const upperRises = [...climb, 0, ...descend];
const upper = run(0n, BigInt(-16 * top - 8), 4, upperRises);

const graph = new TrackGraph(layout);
const label = (p: number, c: number): string => {
  const s = zeta16ToStuds(layout.connectorPose(p, c).position);
  return `(${Math.round(s.x)}, ${Math.round(s.z)}) studs at ${layout.endYPlates(p, c)} pl`;
};
console.table(
  [...lower, ...upper].map((p) => {
    const h = layout.endYPlates(p, 1);
    const { bricks, plates } = riserCourses(h);
    return {
      piece: p,
      line: lower.includes(p) ? "lower" : "upper",
      from: label(p, 0),
      to: label(p, 1),
      "riser under far end": h === 0 ? "on baseplate" : `${bricks} × 3001 + ${plates} × 3020`,
    };
  }),
);
console.log(
  `joins ${graph.joinCount}, open ends ${graph.openEnds.length}, coincident-end issues ${graph.issues.length}`,
);
const span = upper[top] ?? 0;
const level = layout.endYPlates(span, 0);
const upperSpan = { bottomLdu: level * PLATE_LDU, railTopLdu: level * PLATE_LDU + RAIL_TOP_LDU };
const lowerSpan = { bottomLdu: 0, railTopLdu: RAIL_TOP_LDU };
console.log(`upper piece ${span} spans ${label(span, 0)} → ${label(span, 1)}`);
for (const envelope of [96, 97, 120]) {
  console.log(`  envelope ${envelope} LDU →`, JSON.stringify(crossing(lowerSpan, upperSpan, envelope)));
}
const wrongHeight = new TrackLayout([straight]);
wrongHeight.place(0, layout.pose(upper[0] ?? 0), 0, 1);
wrongHeight.place(0, layout.pose(upper[1] ?? 0), 0, 0);
const wrongGraph = new TrackGraph(wrongHeight);
console.log(
  `negative control: a level piece at 0 plates after a 0→1 ramp: joins ${wrongGraph.joinCount}, open ends ${wrongGraph.openEnds.length}`,
);
