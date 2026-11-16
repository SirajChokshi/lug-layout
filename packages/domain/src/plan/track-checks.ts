import {
  CHUNK_LDU,
  HALF_TURN_16,
  lduFromMm,
  mmFromLdu,
  normalizeHeading16,
  STUD_LDU,
  zeta16ToStuds,
} from "@brr/math";
import { NO_END, type TrackGraph } from "../track/track-graph.ts";
import type { TrackLayout } from "../track/track-layout.ts";
import type { PartCount } from "./item-spec.ts";
import {
  rectsOverlap,
  regionOriginX,
  regionOriginZ,
  type LduRect,
  type PlanRegion,
} from "./plan-region.ts";
import type { PlanCheck, PlanIssue, PlanRuleId } from "./plan-rules.ts";
import { crossesInterior, tableEdges } from "./table-edges.ts";

export type TrackPoseStatus = "certified" | "unverified";

export interface TrackPieceInfo {
  readonly id: string;
  readonly title: string;
  readonly part: string;
  readonly ldrawColor: number;
  readonly status: TrackPoseStatus;
  readonly frameXLdu: number;
  readonly frameZLdu: number;
  readonly frameHalfSteps: number;
  readonly boundsMinX: number;
  readonly boundsMaxX: number;
  readonly boundsMinZ: number;
  readonly boundsMaxZ: number;
}

export interface TrackInput {
  readonly layout: TrackLayout;
  readonly graph: TrackGraph;
  readonly pieces: ReadonlyArray<TrackPieceInfo | null>;
}

export interface TrackFootprint {
  readonly placement: number;
  readonly info: TrackPieceInfo;
  readonly corners: ReadonlyArray<readonly [number, number]>;
  readonly box: LduRect;
}

const STEPS_PER_TURN = 16;
const STEP_RADIANS = (2 * Math.PI) / STEPS_PER_TURN;
const DEGREES_PER_STEP = 360 / STEPS_PER_TURN;

function trackIssue(
  rule: PlanRuleId,
  severity: PlanIssue["severity"],
  trackPieces: ReadonlyArray<number>,
  message: string,
): PlanIssue {
  return {
    rule,
    severity,
    placements: [],
    trackPieces,
    message,
    overhangMm: 0,
    nearestTableMm: 0,
    offTableMm2: 0,
  };
}

export function trackFootprints(track: TrackInput): TrackFootprint[] {
  const out: TrackFootprint[] = [];
  for (let p = 0; p < track.layout.count; p++) {
    const info = track.pieces[track.layout.piece(p)];
    if (!info) continue;
    const pose = track.layout.pose(p);
    const studs = zeta16ToStuds(pose.position);
    const theta = pose.heading * STEP_RADIANS;
    const originX =
      studs.x * STUD_LDU + Math.cos(theta) * info.frameXLdu - Math.sin(theta) * info.frameZLdu;
    const originZ =
      studs.z * STUD_LDU + Math.sin(theta) * info.frameXLdu + Math.cos(theta) * info.frameZLdu;
    const phi = theta + (info.frameHalfSteps * STEP_RADIANS) / 2;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const corners = (
      [
        [info.boundsMinX, info.boundsMinZ],
        [info.boundsMaxX, info.boundsMinZ],
        [info.boundsMaxX, info.boundsMaxZ],
        [info.boundsMinX, info.boundsMaxZ],
      ] as const
    ).map(([x, z]) => [originX + c * x - s * z, originZ + s * x + c * z] as const);
    const xs = corners.map(([x]) => x);
    const zs = corners.map(([, z]) => z);
    out.push({
      placement: p,
      info,
      corners,
      box: {
        minX: Math.min(...xs),
        minZ: Math.min(...zs),
        maxX: Math.max(...xs),
        maxZ: Math.max(...zs),
      },
    });
  }
  return out;
}

function label(footprint: TrackFootprint): string {
  return `${footprint.info.part.replace("ldraw:", "")} ${footprint.info.title} #${footprint.placement + 1}`;
}

function at(xLdu: number, zLdu: number, region: PlanRegion): string {
  const x = Math.round(mmFromLdu(xLdu - regionOriginX(region)));
  const z = Math.round(mmFromLdu(zLdu - regionOriginZ(region)));
  return `(${x} mm, ${z} mm)`;
}

function inside(rect: LduRect, x: number, z: number): boolean {
  return x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
}

function overhang(
  corners: ReadonlyArray<readonly [number, number]>,
  supports: ReadonlyArray<LduRect>,
): number {
  let worst = 0;
  for (const [x, z] of corners) {
    if (supports.some((rect) => inside(rect, x, z))) continue;
    let nearest = Number.POSITIVE_INFINITY;
    for (const rect of supports) {
      const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
      const dz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
      nearest = Math.min(nearest, Math.hypot(dx, dz));
    }
    worst = Math.max(worst, nearest);
  }
  return worst;
}

function grown(rect: LduRect, by: number): LduRect {
  return { minX: rect.minX - by, minZ: rect.minZ - by, maxX: rect.maxX + by, maxZ: rect.maxZ + by };
}

function onModuleGrid(value: number, origin: number, side: number): boolean {
  return (((value - origin) % side) + side) % side === 0;
}

export function trackBomLines(footprints: ReadonlyArray<TrackFootprint>): PartCount[] {
  return footprints.map((f) => ({ part: f.info.part, ldrawColor: f.info.ldrawColor, quantity: 1 }));
}

export function trackIssues(
  region: PlanRegion,
  check: PlanCheck,
  track: TrackInput,
  footprints: ReadonlyArray<TrackFootprint>,
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const byPlacement = new Map(footprints.map((f) => [f.placement, f]));
  const { graph } = track;
  const inFailedJoin = new Set(graph.issues.flatMap((problem) => problem.ends));
  for (let i = 0; i < graph.openEnds.length; i++) {
    const end = graph.openEnds[i] ?? 0;
    if (inFailedJoin.has(end)) continue;
    const placement = graph.endPlacement[end] ?? 0;
    const footprint = byPlacement.get(placement);
    if (!footprint) continue;
    issues.push(
      trackIssue(
        "trackOpenEnd",
        "error",
        [placement],
        `Open track end at ${at(graph.endXLdu[end] ?? 0, graph.endZLdu[end] ?? 0, region)} on ${label(footprint)}: nothing joins it and no buffer caps it.`,
      ),
    );
  }
  for (const problem of graph.issues) {
    const ends = problem.ends;
    const placements = [...new Set(ends.map((end) => graph.endPlacement[end] ?? 0))].filter((p) =>
      byPlacement.has(p),
    );
    if (placements.length === 0) continue;
    const [first, second] = ends;
    const headingGap =
      first !== undefined && second !== undefined && ends.length === 2
        ? normalizeHeading16(
            (graph.endHeading[first] ?? 0) - (graph.endHeading[second] ?? 0) - HALF_TURN_16,
          )
        : null;
    const names = placements.map((p) => {
      const footprint = byPlacement.get(p);
      return footprint ? label(footprint) : `#${p + 1}`;
    });
    const why =
      headingGap === null
        ? `${ends.length} ends meet at one point`
        : `their headings are ${Math.min(headingGap, STEPS_PER_TURN - headingGap) * DEGREES_PER_STEP}° off a straight join`;
    issues.push(
      trackIssue(
        "trackJoin",
        "error",
        placements,
        `${names.join(" and ")} meet at ${at(graph.endXLdu[first ?? 0] ?? 0, graph.endZLdu[first ?? 0] ?? 0, region)} but don't join: ${why}.`,
      ),
    );
  }
  const unverified = new Map<string, TrackFootprint[]>();
  for (const footprint of footprints) {
    if (footprint.info.status !== "unverified") continue;
    unverified.set(footprint.info.id, [...(unverified.get(footprint.info.id) ?? []), footprint]);
  }
  for (const [id, group] of unverified) {
    const sample = group[0];
    if (!sample) continue;
    const joined = group.filter((f) => {
      for (
        let end = graph.endStart[f.placement] ?? 0;
        end < (graph.endStart[f.placement + 1] ?? 0);
        end++
      ) {
        if ((graph.endPartner[end] ?? NO_END) !== NO_END) return true;
      }
      return false;
    }).length;
    issues.push(
      trackIssue(
        "trackUnverified",
        "warning",
        group.map((f) => f.placement),
        `${group.length} × ${id.replace("ldraw:", "")} ${sample.info.title}: unverified connector poses. Its LDraw file has 3-decimal coordinates, too coarse for the unique ℤ[ζ₁₆] identification (§5.3), so its poses come from its !HELP rotation point; ${joined} of these pieces have joins that are exact in the model but not certified from the part data.`,
      ),
    );
  }
  const supports = check.tables.map((t) => grown(t.surface, lduFromMm(region.maxOverhangMm)));
  for (const footprint of footprints) {
    const past = overhang(footprint.corners, supports);
    if (past <= 0) continue;
    issues.push(
      trackIssue(
        "trackFit",
        "error",
        [footprint.placement],
        `${label(footprint)} hangs ${Math.round(mmFromLdu(past))} mm past the table edge (limit ${region.maxOverhangMm} mm).`,
      ),
    );
  }
  const side = CHUNK_LDU;
  const originX = regionOriginX(region);
  const originZ = regionOriginZ(region);
  const offGridSeams = tableEdges(check.tables.map((t) => t.surface)).seams.filter((seam) =>
    seam.az === seam.bz
      ? !onModuleGrid(seam.az, originZ, side)
      : !onModuleGrid(seam.ax, originX, side),
  );
  for (const footprint of footprints) {
    if (!offGridSeams.some((seam) => crossesInterior(seam, footprint.box))) continue;
    issues.push(
      trackIssue(
        "trackSeam",
        "warning",
        [footprint.placement],
        `${label(footprint)} crosses a table seam that isn't on a 32-stud module edge.`,
      ),
    );
  }
  return issues;
}

export function trackInRegion(
  footprints: ReadonlyArray<TrackFootprint>,
  room: LduRect,
): TrackFootprint[] {
  return footprints.filter((f) => rectsOverlap(f.box, room));
}
