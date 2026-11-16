import { applyToPoint, IDENTITY, type Affine } from "../ldraw/affine.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { findTrackEnds, type TrackEnd, type TrackEndMarker } from "../track/track-ends.ts";

const MAIN_COLOR = 16;
const ROAD_PLATE_PITCH_LDU = 720;
const DECIMALS = 6;
const SCENE_AUTHOR = "Brick Railroad tools/asset-pipeline (cli.ts facts, from measured end poses)";
const STRAIGHTS_AFTER_SWITCH = 2;
const PLACEMENT_ANGLE_GRID = Math.PI / 16;
const ROAD_STRAIGHTS = ["44336", "2358", "610", "606", "30225b"];

interface ScenePlacement {
  readonly part: string;
  readonly transform: Affine;
}

function rotationY(angle: number): Affine {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos, 0, -sin, 0, 1, 0, sin, 0, cos, 0, 0, 0];
}

function translated(m: Affine, x: number, z: number): Affine {
  return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], x, 0, z];
}

function placedEnds(ends: ReadonlyArray<TrackEnd>, transform: Affine): ReadonlyArray<TrackEnd> {
  const rotation = translated(transform, 0, 0);
  return ends.map((end) => {
    const [x, , z] = applyToPoint(transform, [end.x, 0, end.z]);
    const [dx, , dz] = applyToPoint(rotation, [Math.cos(end.outward), 0, Math.sin(end.outward)]);
    return { ...end, x, z, outward: Math.atan2(dz, dx) };
  });
}

function attachByEnd(ends: ReadonlyArray<TrackEnd>, joinEnd: number, target: TrackEnd): Affine {
  const end = ends[joinEnd];
  if (end === undefined) throw new Error(`no end ${joinEnd}`);
  const angle = target.outward + Math.PI - end.outward;
  const rotation = rotationY(Math.round(angle / PLACEMENT_ANGLE_GRID) * PLACEMENT_ANGLE_GRID);
  const [x, , z] = applyToPoint(rotation, [end.x, 0, end.z]);
  return translated(rotation, target.x - x, target.z - z);
}

function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(DECIMALS));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function toLdraw(title: string, placements: ReadonlyArray<ScenePlacement>): string {
  const lines = placements.map(({ part, transform }) => {
    const [a, b, c, d, e, f, g, h, i, x, y, z] = transform;
    return [1, MAIN_COLOR, x, y, z, a, b, c, d, e, f, g, h, i]
      .map((value) => formatNumber(value))
      .concat(`${part}.dat`)
      .join(" ");
  });
  return [
    `0 ${title}`,
    `0 Name: ${title.toLowerCase().replaceAll(" ", "-")}.ldr`,
    `0 Author: ${SCENE_AUTHOR}`,
    ...lines,
    "",
  ].join("\n");
}

function farthestEnd(ends: ReadonlyArray<TrackEnd>, from: TrackEnd): TrackEnd {
  const sorted = ends.toSorted(
    (p, q) => Math.hypot(q.x - from.x, q.z - from.z) - Math.hypot(p.x - from.x, p.z - from.z),
  );
  const far = sorted[0];
  if (far === undefined) throw new Error("part has no ends");
  return far;
}

export function switchParallelScene(
  library: LdrawLibrary,
  markers: ReadonlyArray<TrackEndMarker>,
): string {
  const switchEnds = findTrackEnds(library, "75541-f2", markers);
  const curveEnds = findTrackEnds(library, "74747", markers);
  const straightEnds = findTrackEnds(library, "74746", markers);
  const byX = [...switchEnds].toSorted((p, q) => p.x - q.x);
  const entry = byX[0];
  const exits = byX
    .slice(1)
    .toSorted((p, q) => Math.abs(Math.sin(p.outward)) - Math.abs(Math.sin(q.outward)));
  const [straightExit, diverging] = exits;
  if (entry === undefined || straightExit === undefined || diverging === undefined) {
    throw new Error("75541-f2 needs three ends");
  }
  const placements: ScenePlacement[] = [{ part: "75541-f2", transform: IDENTITY }];
  const curve = attachByEnd(curveEnds, 1, diverging);
  placements.push({ part: "74747", transform: curve });
  const curveExit = farthestEnd(placedEnds(curveEnds, curve), diverging);
  let tip = straightExit;
  for (let segment = 0; segment < STRAIGHTS_AFTER_SWITCH; segment += 1) {
    const straight = attachByEnd(straightEnds, 0, tip);
    placements.push({ part: "74746", transform: straight });
    tip = farthestEnd(placedEnds(straightEnds, straight), tip);
  }
  placements.push({ part: "74746", transform: attachByEnd(straightEnds, 0, curveExit) });
  return toLdraw("Switch Then Reversed Curve", placements);
}

export function roadBaseplateScene(): string {
  return toLdraw(
    "Road Baseplates",
    ROAD_STRAIGHTS.map((part, index) => ({
      part,
      transform: translated(IDENTITY, 0, index * ROAD_PLATE_PITCH_LDU),
    })),
  );
}
