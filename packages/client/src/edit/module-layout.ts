import {
  classifyModuleEdge,
  MODULE_SIDES,
  ModuleGrid,
  NO_TOP,
  type ModuleEdge,
  type ModuleEdgeStatus,
  type ModuleFit,
  type ModuleJoinReport,
  type ModuleSide,
} from "@brr/domain";
import type { MilsEdgeRules } from "@brr/schema/bundle";
import { PLATE_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import type { EdgeMarker, WorldBox } from "@brr/render";
import type { ModuleSurface } from "./module-surface.ts";
import type { PlacedModel } from "./placed-chunks.ts";

const QUARTER_TURNS = 4;
const SIDE_BAR_WIDTH_LDU = 6;
const SIDE_BAR_HEIGHT_LDU = 3;
const FEATURE_BAR_WIDTH_LDU = 12;
const FEATURE_BAR_HEIGHT_LDU = 12;
const MARKER_LIFT_LDU = 1;

export interface ModulePose {
  readonly x: number;
  readonly z: number;
  readonly column: number;
  readonly row: number;
  readonly rot: number;
}

export interface ModuleCandidate extends ModulePose {
  readonly edges: ReadonlyArray<ModuleEdge>;
  readonly fit: ModuleFit;
}

interface Turn {
  readonly cos: number;
  readonly sin: number;
}

function turn(rot: number): Turn {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  return { cos: rot90Cos(rot), sin: rot90Sin(rot) };
}

function footprintMin(
  surface: ModuleSurface,
  rot: number,
): { readonly x: number; readonly z: number } {
  const { cos, sin } = turn(rot);
  const size = surface.studs * STUD_LDU;
  let x = Number.POSITIVE_INFINITY;
  let z = Number.POSITIVE_INFINITY;
  for (const lx of [surface.minX, surface.minX + size]) {
    for (const lz of [surface.minZ, surface.minZ + size]) {
      x = Math.min(x, cos * lx + sin * lz);
      z = Math.min(z, -sin * lx + cos * lz);
    }
  }
  return { x, z };
}

function sideCell(side: ModuleSide, along: number, studs: number): readonly [number, number] {
  switch (side) {
    case "minX":
      return [0, along];
    case "maxX":
      return [studs - 1, along];
    case "minZ":
      return [along, 0];
    case "maxZ":
      return [along, studs - 1];
    default: {
      const unhandled: never = side;
      throw new Error(`unhandled side ${String(unhandled)}`);
    }
  }
}

function better(a: ModuleFit, b: ModuleFit): number {
  return a.mismatched - b.mismatched || b.joined - a.joined;
}

export class ModuleLayout {
  private grid = new ModuleGrid([]);
  private gridModels: ReadonlyArray<PlacedModel> = [];
  private gridEdges: ReadonlyArray<ReadonlyArray<ModuleEdge>> = [];
  private latest: ModuleJoinReport;
  private offGridCount = 0;

  constructor(private readonly rules: MilsEdgeRules) {
    this.latest = this.grid.report();
  }

  private get sizeLdu(): number {
    return this.rules.moduleStuds * STUD_LDU;
  }

  fitsGrid(surface: ModuleSurface): boolean {
    return surface.studs === this.rules.moduleStuds;
  }

  pose(surface: ModuleSurface, rot: number, hitX: number, hitZ: number): ModulePose {
    const column = Math.floor(hitX / this.sizeLdu);
    const row = Math.floor(hitZ / this.sizeLdu);
    const min = footprintMin(surface, rot);
    return {
      x: column * this.sizeLdu - min.x + 0,
      z: row * this.sizeLdu - min.z + 0,
      column,
      row,
      rot,
    };
  }

  edges(surface: ModuleSurface, x: number, z: number, rot: number): ReadonlyArray<ModuleEdge> {
    const { cos, sin } = turn(rot);
    const min = footprintMin(surface, rot);
    const studs = surface.studs;
    return MODULE_SIDES.map((side) => {
      const plates = new Int16Array(studs);
      const colors = new Int32Array(studs);
      for (let along = 0; along < studs; along++) {
        const [i, j] = sideCell(side, along, studs);
        const dx = min.x + (i + 0.5) * STUD_LDU;
        const dz = min.z + (j + 0.5) * STUD_LDU;
        const lx = cos * dx - sin * dz;
        const lz = sin * dx + cos * dz;
        const column = Math.floor((lx - surface.minX) / STUD_LDU);
        const row = Math.floor((lz - surface.minZ) / STUD_LDU);
        const cell = row * studs + column;
        plates[along] = surface.plates[cell] ?? NO_TOP;
        colors[along] = surface.colors[cell] ?? 0;
      }
      return { kind: classifyModuleEdge(this.rules, plates, colors), plates, colors };
    });
  }

  candidate(surface: ModuleSurface, rot: number, hitX: number, hitZ: number): ModuleCandidate {
    const pose = this.pose(surface, rot, hitX, hitZ);
    const edges = this.edges(surface, pose.x, pose.z, rot);
    return { ...pose, edges, fit: this.grid.fit(pose.column, pose.row, edges) };
  }

  bestCandidate(
    surface: ModuleSurface,
    preferred: number,
    hitX: number,
    hitZ: number,
  ): ModuleCandidate {
    const options = Array.from({ length: QUARTER_TURNS }, (_, k) =>
      this.candidate(surface, (preferred + k) % QUARTER_TURNS, hitX, hitZ),
    );
    return options.reduce((best, option) => (better(option.fit, best.fit) < 0 ? option : best));
  }

  refresh(models: ReadonlyArray<PlacedModel>): ModuleJoinReport {
    const gridModels: PlacedModel[] = [];
    const gridEdges: Array<ReadonlyArray<ModuleEdge>> = [];
    const cells: Array<{
      id: number;
      column: number;
      row: number;
      edges: ReadonlyArray<ModuleEdge>;
    }> = [];
    let offGrid = 0;
    for (const model of models) {
      const surface = model.placeable.module;
      if (!surface) continue;
      const { x, z, rot } = model.handle;
      const min = footprintMin(surface, rot);
      const column = (x + min.x) / this.sizeLdu;
      const row = (z + min.z) / this.sizeLdu;
      if (!this.fitsGrid(surface) || !Number.isInteger(column) || !Number.isInteger(row)) {
        offGrid++;
        continue;
      }
      const edges = this.edges(surface, x, z, rot);
      cells.push({ id: gridModels.length, column, row, edges });
      gridModels.push(model);
      gridEdges.push(edges);
    }
    this.grid = new ModuleGrid(cells);
    this.gridModels = gridModels;
    this.gridEdges = gridEdges;
    this.offGridCount = offGrid;
    this.latest = this.grid.report();
    return this.latest;
  }

  get report(): ModuleJoinReport {
    return this.latest;
  }

  get offGrid(): number {
    return this.offGridCount;
  }

  isOccupied(column: number, row: number): boolean {
    return this.grid.occupant(column, row) !== null;
  }

  modelOf(id: number): PlacedModel | null {
    return this.gridModels[id] ?? null;
  }

  markers(): ReadonlyArray<EdgeMarker> {
    return this.latest.edges.flatMap((edge) => {
      const model = this.gridModels[edge.module];
      const edges = this.gridEdges[edge.module];
      const sample = edges?.[MODULE_SIDES.indexOf(edge.side)];
      if (!model || !sample) return [];
      const surface = model.placeable.module;
      if (!surface) return [];
      const min = footprintMin(surface, model.handle.rot);
      return this.sideMarkers(
        model.handle.x + min.x,
        model.handle.z + min.z,
        edge.side,
        sample,
        edge.status,
      );
    });
  }

  ghostMarkers(candidate: ModuleCandidate, surface: ModuleSurface): ReadonlyArray<EdgeMarker> {
    const min = footprintMin(surface, candidate.rot);
    return MODULE_SIDES.flatMap((side, index) => {
      const edge = candidate.edges[index];
      const status = candidate.fit.statuses[index];
      if (!edge || !status) return [];
      return this.sideMarkers(candidate.x + min.x, candidate.z + min.z, side, edge, status);
    });
  }

  private sideMarkers(
    originX: number,
    originZ: number,
    side: ModuleSide,
    edge: ModuleEdge,
    status: ModuleEdgeStatus,
  ): ReadonlyArray<EdgeMarker> {
    let topPlates = 0;
    for (const plates of edge.plates)
      if (plates !== NO_TOP) topPlates = Math.max(topPlates, plates);
    const lift = topPlates * PLATE_LDU + MARKER_LIFT_LDU;
    const size = this.sizeLdu;
    const markers: EdgeMarker[] = [
      {
        box: this.bar(
          originX,
          originZ,
          side,
          0,
          size,
          SIDE_BAR_WIDTH_LDU,
          lift,
          SIDE_BAR_HEIGHT_LDU,
        ),
        kind: status,
      },
    ];
    const feature = this.rules.features.find((rule) => rule.kind === edge.kind);
    if (feature) {
      const from = ((this.rules.moduleStuds - feature.widthStuds) / 2) * STUD_LDU;
      const to = from + feature.widthStuds * STUD_LDU;
      markers.push({
        box: this.bar(
          originX,
          originZ,
          side,
          from,
          to,
          FEATURE_BAR_WIDTH_LDU,
          lift,
          FEATURE_BAR_HEIGHT_LDU,
        ),
        kind: status,
      });
    }
    return markers;
  }

  private bar(
    originX: number,
    originZ: number,
    side: ModuleSide,
    from: number,
    to: number,
    width: number,
    minY: number,
    height: number,
  ): WorldBox {
    const size = this.sizeLdu;
    const maxY = minY + height;
    switch (side) {
      case "minX":
        return {
          minX: originX,
          maxX: originX + width,
          minY,
          maxY,
          minZ: originZ + from,
          maxZ: originZ + to,
        };
      case "maxX":
        return {
          minX: originX + size - width,
          maxX: originX + size,
          minY,
          maxY,
          minZ: originZ + from,
          maxZ: originZ + to,
        };
      case "minZ":
        return {
          minX: originX + from,
          maxX: originX + to,
          minY,
          maxY,
          minZ: originZ,
          maxZ: originZ + width,
        };
      case "maxZ":
        return {
          minX: originX + from,
          maxX: originX + to,
          minY,
          maxY,
          minZ: originZ + size - width,
          maxZ: originZ + size,
        };
      default: {
        const unhandled: never = side;
        throw new Error(`unhandled side ${String(unhandled)}`);
      }
    }
  }
}
