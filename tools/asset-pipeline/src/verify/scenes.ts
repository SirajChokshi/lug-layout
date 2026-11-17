import { applyToPoint, IDENTITY, type Affine } from "../ldraw/affine.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { INHERIT_COLOR } from "../ldraw/walk.ts";
import type { BaseplateMeasurement } from "./geometry.ts";
import {
  findTrackEnds,
  PART_FRAME_HEADING_GRID,
  type MarkerEnd,
  type TrackEndMarker,
} from "../track/track-ends.ts";

const DECIMALS = 6;
const SCENE_AUTHOR = "Brick Railroad tools/asset-pipeline (cli.ts facts)";
const STRAIGHTS_AFTER_SWITCH = 2;

export interface ScenePlacement {
  readonly part: string;
  readonly transform: Affine;
}

export function rotationY(angle: number): Affine {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos, 0, -sin, 0, 1, 0, sin, 0, cos, 0, 0, 0];
}

export function translated(m: Affine, x: number, z: number): Affine {
  return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], x, 0, z];
}

function placedEnds(ends: ReadonlyArray<MarkerEnd>, transform: Affine): ReadonlyArray<MarkerEnd> {
  const rotation = translated(transform, 0, 0);
  return ends.map((end) => {
    const [x, , z] = applyToPoint(transform, [end.x, 0, end.z]);
    const [dx, , dz] = applyToPoint(rotation, [Math.cos(end.outward), 0, Math.sin(end.outward)]);
    return { ...end, x, z, outward: Math.atan2(dz, dx) };
  });
}

function attachByEnd(ends: ReadonlyArray<MarkerEnd>, joinEnd: number, target: MarkerEnd): Affine {
  const end = ends[joinEnd];
  if (end === undefined) throw new Error(`no end ${joinEnd}`);
  const angle = target.outward + Math.PI - end.outward;
  const rotation = rotationY(Math.round(angle / PART_FRAME_HEADING_GRID) * PART_FRAME_HEADING_GRID);
  const [x, , z] = applyToPoint(rotation, [end.x, 0, end.z]);
  return translated(rotation, target.x - x, target.z - z);
}

function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(DECIMALS));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function toLdraw(
  title: string,
  method: string,
  placements: ReadonlyArray<ScenePlacement>,
): string {
  const lines = placements.map(({ part, transform }) => {
    const [a, b, c, d, e, f, g, h, i, x, y, z] = transform;
    return [1, INHERIT_COLOR, x, y, z, a, b, c, d, e, f, g, h, i]
      .map((value) => formatNumber(value))
      .concat(`${part}.dat`)
      .join(" ");
  });
  return [
    `0 ${title}`,
    `0 Name: ${title.toLowerCase().replaceAll(" ", "-")}.ldr`,
    `0 Author: ${SCENE_AUTHOR}, ${method}`,
    ...lines,
    "",
  ].join("\n");
}

function farthestEnd(ends: ReadonlyArray<MarkerEnd>, from: MarkerEnd): MarkerEnd {
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
  return toLdraw("Switch Then Reversed Curve", "placed from measured track-end poses", placements);
}

export function roadBaseplateScene(plates: ReadonlyArray<BaseplateMeasurement>): string {
  const placements: ScenePlacement[] = [];
  let edge = 0;
  for (const plate of plates) {
    const z = edge - plate.zExtent.from;
    const x = -(plate.xExtent.from + plate.xExtent.to) / 2;
    placements.push({ part: plate.part, transform: translated(IDENTITY, x, z) });
    edge = z + plate.zExtent.to;
  }
  return toLdraw(
    "Road Baseplates",
    "abutted edge to edge using measured plate extents",
    placements,
  );
}
