import { PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import type { BundleLod } from "@brr/schema/bundle";
import {
  AXIS_NEG_Y,
  AXIS_POS_Y,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  pierCourses,
  type PlacementPose,
  type SnapShapes,
} from "@brr/domain";
import type { WorldBox } from "@brr/render";
import { inject, injectable } from "inversify";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import { PLACEABLE_CATALOG, SNAP_SHAPES, WORLD_SESSION } from "../tokens.ts";
import type { IWorldSession } from "./world-session.ts";
import { PLATE_LDU, SIXTEENTHS_PER_LDU, STUD_LDU } from "@brr/math";
import type { Placeable } from "./placeable.ts";
import { posedBox, posedCell } from "./placed-chunks.ts";
import { cellKey } from "./track-obstacles.ts";

const PIER_TALL_PART = "ldraw:3001";
const PIER_SHORT_PART = "ldraw:3020";
const PIER_COLOR = 71;

const ORIGIN_INTS = 3;
const Y = 1;
const ON_LATTICE = 1;
const QUARTER_TURNS = 4;
const LDRAW_PART_PREFIX = "ldraw:";

export interface PierCourse {
  readonly part: string;
  readonly topLdu: number;
  readonly bottomLdu: number;
}

export interface PierKit {
  readonly tall: PierCourse;
  readonly short: PierCourse;
  readonly color: number;
}

export interface PierFile {
  readonly name: string;
  readonly text: string;
}

export interface PierSite {
  readonly x: number;
  readonly z: number;
  readonly rot: number;
  readonly mates: number;
}

function faceLdu(
  table: ConnectorTable,
  gender: number,
  axis: number,
  pick: typeof Math.max,
): number | null {
  let face: number | null = null;
  for (let c = 0; c < table.count; c++) {
    if (table.gender[c] !== gender || table.axis[c] !== axis) continue;
    const y = table.origin[c * ORIGIN_INTS + Y] ?? 0;
    face = face === null ? y : pick(face, y);
  }
  if (face === null || face % SIXTEENTHS_PER_LDU !== 0) return null;
  return face / SIXTEENTHS_PER_LDU;
}

export function pierCourse(part: string, table: ConnectorTable): PierCourse | null {
  const topLdu = faceLdu(table, GENDER_MALE, AXIS_POS_Y, Math.max);
  const bottomLdu = faceLdu(table, GENDER_FEMALE, AXIS_NEG_Y, Math.min);
  if (topLdu === null || bottomLdu === null) return null;
  const pitch = topLdu - bottomLdu;
  if (pitch <= 0 || pitch % PLATE_LDU !== 0) return null;
  return { part, topLdu, bottomLdu };
}

function pitchPlates(course: PierCourse): number {
  return (course.topLdu - course.bottomLdu) / PLATE_LDU;
}

function courseLine(course: PierCourse, color: number, offsetLdu: number): string {
  const file = `${course.part.replace(LDRAW_PART_PREFIX, "")}.dat`;
  return `1 ${color} 0 ${-offsetLdu} 0 1 0 0 0 1 0 0 0 1 ${file}`;
}

export function pierFile(kit: PierKit, heightPlates: number): PierFile | null {
  const courses = pierCourses(heightPlates, pitchPlates(kit.tall), pitchPlates(kit.short));
  if (!courses) return null;
  const stack = [
    ...Array.from({ length: courses.tall }, () => kit.tall),
    ...Array.from({ length: courses.short }, () => kit.short),
  ];
  const name = `track-pier-${heightPlates}-plates.ldr`;
  const lines = [
    `0 Track pier, ${heightPlates} plates`,
    `0 Name: ${name}`,
    "0 Author: Brick Railroad",
  ];
  let offset = 0;
  let below: PierCourse | null = null;
  for (const course of stack) {
    if (below) offset += below.topLdu - course.bottomLdu;
    lines.push(courseLine(course, kit.color, offset));
    below = course;
  }
  return { name, text: `${lines.join("\n")}\n` };
}

function topStuds(pier: Placeable): ReadonlyArray<readonly [number, number]> {
  const { onLattice, cellX, cellZ, baseLdu } = pier.studLattice;
  let top = Number.NEGATIVE_INFINITY;
  for (let s = 0; s < onLattice.length; s++) {
    if (onLattice[s] === ON_LATTICE) top = Math.max(top, baseLdu[s] ?? 0);
  }
  const studs: Array<readonly [number, number]> = [];
  for (let s = 0; s < onLattice.length; s++) {
    if (onLattice[s] === ON_LATTICE && baseLdu[s] === top)
      studs.push([cellX[s] ?? 0, cellZ[s] ?? 0]);
  }
  return studs;
}

export function pierTopLdu(pier: Placeable): number | null {
  const { onLattice, baseLdu } = pier.studLattice;
  let top: number | null = null;
  for (let s = 0; s < onLattice.length; s++) {
    if (onLattice[s] === ON_LATTICE)
      top = Math.max(top ?? Number.NEGATIVE_INFINITY, baseLdu[s] ?? 0);
  }
  return top;
}

interface RankedSite extends PierSite {
  readonly distance: number;
}

function ranked(a: RankedSite, b: RankedSite): number {
  return b.mates - a.mates || a.distance - b.distance || a.rot - b.rot || a.x - b.x || a.z - b.z;
}

export function pierSites(
  pier: Placeable,
  antiStuds: Int32Array,
  centreX: number,
  centreZ: number,
): ReadonlyArray<PierSite> {
  const studs = topStuds(pier);
  const [first] = studs;
  if (!first || antiStuds.length === 0) return [];
  const under = new Set<number>();
  for (let i = 0; i < antiStuds.length; i += 2) {
    under.add(cellKey(antiStuds[i] ?? 0, antiStuds[i + 1] ?? 0));
  }
  const cell = new Int32Array(2);
  const sites = new Map<string, RankedSite>();
  for (let rot = 0; rot < QUARTER_TURNS; rot++) {
    posedCell(0, 0, rot, first[0], first[1], cell);
    const firstX = cell[0] ?? 0;
    const firstZ = cell[1] ?? 0;
    for (let i = 0; i < antiStuds.length; i += 2) {
      const x = ((antiStuds[i] ?? 0) - firstX) * STUD_LDU;
      const z = ((antiStuds[i + 1] ?? 0) - firstZ) * STUD_LDU;
      const key = `${rot}:${x}:${z}`;
      if (sites.has(key)) continue;
      let mates = 0;
      for (const [sx, sz] of studs) {
        posedCell(x, z, rot, sx, sz, cell);
        if (under.has(cellKey(cell[0] ?? 0, cell[1] ?? 0))) mates++;
      }
      const box = posedBox(pier.box, x, z, 0, rot);
      const dx = (box.minX + box.maxX) / 2 - centreX;
      const dz = (box.minZ + box.maxZ) / 2 - centreZ;
      sites.set(key, { x, z, rot, mates, distance: Math.hypot(dx, dz) });
    }
  }
  return [...sites.values()].toSorted(ranked).map(({ x, z, rot, mates }) => ({ x, z, rot, mates }));
}

const PIER_PARTS_LOD: BundleLod = "standard";
const PIER_COLOR_ID = 0;
const ON_THE_TABLE = 0;

export interface PierPiece {
  readonly index: number;
  readonly bottomLdu: number;
  readonly antiStuds: Int32Array;
  readonly centreX: number;
  readonly centreZ: number;
}

export interface PierRequest {
  readonly pieces: ReadonlyArray<PierPiece>;
  readonly fits: (
    pier: Placeable,
    pose: PlacementPose,
    posed: WorldBox,
    piece: PierPiece,
  ) => boolean;
  readonly studsChecked: (item: string) => Promise<void>;
}

export interface ITrackPiers {
  piersFor(request: PierRequest): Promise<ReadonlyArray<PlacementPose>>;
}

function planOverlap(a: WorldBox, b: WorldBox): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

@injectable()
export class TrackPiers implements ITrackPiers {
  private kit: Promise<PierKit | null> | null = null;

  constructor(
    @inject(WORLD_SESSION) private readonly session: IWorldSession,
    @inject(PLACEABLE_CATALOG) private readonly catalog: IPlaceableCatalog,
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SNAP_SHAPES) private readonly shapes: SnapShapes,
  ) {}

  async piersFor(request: PierRequest): Promise<ReadonlyArray<PlacementPose>> {
    const kit = await this.pierKit();
    if (!kit) return [];
    const refs = new Map<number, number | null>();
    for (const { bottomLdu } of request.pieces) {
      if (bottomLdu <= 0 || bottomLdu % PLATE_LDU !== 0 || refs.has(bottomLdu)) continue;
      refs.set(bottomLdu, await this.pierRef(kit, bottomLdu / PLATE_LDU, request.studsChecked));
    }
    const chosen: PlacementPose[] = [];
    const taken: WorldBox[] = [];
    for (const piece of request.pieces) {
      const refId = refs.get(piece.bottomLdu) ?? null;
      const pier = refId === null ? null : this.catalog.placeables()[refId];
      if (refId === null || !pier || pierTopLdu(pier) !== piece.bottomLdu) continue;
      for (const site of pierSites(pier, piece.antiStuds, piece.centreX, piece.centreZ)) {
        const { x, z, rot } = site;
        const pose = { refId, colorId: PIER_COLOR_ID, x, z, yPlates: ON_THE_TABLE, rot };
        const posed = posedBox(pier.box, x, z, ON_THE_TABLE, rot);
        if (taken.some((other) => planOverlap(other, posed))) continue;
        if (!request.fits(pier, pose, posed, piece)) continue;
        chosen.push(pose);
        taken.push(posed);
        break;
      }
    }
    return chosen;
  }

  private pierKit(): Promise<PierKit | null> {
    this.kit ??= this.measureKit().catch((error: unknown) => {
      this.kit = null;
      throw error;
    });
    return this.kit;
  }

  private async measureKit(): Promise<PierKit | null> {
    const [tall, short] = await Promise.all(
      [PIER_TALL_PART, PIER_SHORT_PART].map(async (part) => {
        const loaded = await this.loader.readPartConnectors(PIER_PARTS_LOD, part);
        if (loaded.kind !== "loaded") return null;
        return pierCourse(part, ConnectorTable.fromColumns(loaded.connectors, this.shapes, part));
      }),
    );
    return tall && short ? { tall, short, color: PIER_COLOR } : null;
  }

  private async pierRef(
    kit: PierKit,
    heightPlates: number,
    studsChecked: (item: string) => Promise<void>,
  ): Promise<number | null> {
    const file = pierFile(kit, heightPlates);
    if (!file) return null;
    const bytes = new TextEncoder().encode(file.text);
    const item = await this.session.addModelFile({ name: file.name, bytes });
    if (item === null) return null;
    await studsChecked(item);
    return this.catalog.itemRefId(item);
  }
}
