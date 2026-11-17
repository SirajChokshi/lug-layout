import type { MilsEdgeFeatureRule, MilsEdgeRules, MilsFeature } from "@brr/schema/bundle";

export const NO_TOP = -0x8000;

export type ModuleSide = "minX" | "maxX" | "minZ" | "maxZ";
export const MODULE_SIDES: ReadonlyArray<ModuleSide> = ["minX", "maxX", "minZ", "maxZ"];

export type ModuleEdgeKind = MilsFeature | "terrain" | "other";
export type ModuleEdgeStatus = "joined" | "mismatch" | "open";

export interface ModuleEdge {
  readonly kind: ModuleEdgeKind;
  readonly plates: Int16Array;
  readonly colors: Int32Array;
}

export interface GridModule {
  readonly id: number;
  readonly column: number;
  readonly row: number;
  readonly edges: ReadonlyArray<ModuleEdge>;
}

export interface ModuleEdgeReport {
  readonly module: number;
  readonly side: ModuleSide;
  readonly kind: ModuleEdgeKind;
  readonly status: ModuleEdgeStatus;
  readonly facing: ModuleEdgeKind | null;
}

export interface ModuleJoinCounts {
  readonly joined: number;
  readonly mismatched: number;
  readonly open: number;
}

export interface ModuleFit extends ModuleJoinCounts {
  readonly statuses: ReadonlyArray<ModuleEdgeStatus>;
}

export interface ModuleJoinReport extends ModuleJoinCounts {
  readonly modules: number;
  readonly edges: ReadonlyArray<ModuleEdgeReport>;
}

interface SideCheck {
  readonly status: ModuleEdgeStatus;
  readonly facing: ModuleEdgeKind | null;
}

function within(value: number, low: number, high: number): boolean {
  return value !== NO_TOP && value >= low && value <= high;
}

function matchesFeature(
  rules: MilsEdgeRules,
  feature: MilsEdgeFeatureRule,
  plates: Int16Array,
  colors: Int32Array,
): boolean {
  const studs = rules.moduleStuds;
  const spare = studs - feature.widthStuds;
  if (spare < 0 || spare % 2 !== 0) return false;
  const from = spare / 2;
  const to = from + feature.widthStuds;
  const surfaceLow = rules.surfacePlates - rules.surfaceTolerancePlates;
  const surfaceHigh = rules.surfacePlates + rules.surfaceTolerancePlates;
  for (const flank of [from - feature.bankStuds - 1, to + feature.bankStuds]) {
    if (flank < 0 || flank >= studs) return false;
    if (feature.ldrawColors.includes(colors[flank] ?? 0)) return false;
  }
  for (let stud = 0; stud < studs; stud++) {
    const height = plates[stud] ?? NO_TOP;
    if (stud >= from && stud < to) {
      const low = feature.plates - feature.belowPlates;
      const high = feature.plates + feature.abovePlates;
      if (!within(height, low, high) || !feature.ldrawColors.includes(colors[stud] ?? 0)) {
        return false;
      }
      continue;
    }
    const distance = stud < from ? from - stud : stud - to + 1;
    const fits =
      distance <= feature.bankStuds
        ? within(height, feature.plates, surfaceHigh)
        : within(height, surfaceLow, surfaceHigh);
    if (!fits) return false;
  }
  return true;
}

export function classifyModuleEdge(
  rules: MilsEdgeRules,
  plates: Int16Array,
  colors: Int32Array,
): ModuleEdgeKind {
  if (plates.length !== rules.moduleStuds || colors.length !== rules.moduleStuds) return "other";
  for (const feature of rules.features) {
    if (matchesFeature(rules, feature, plates, colors)) return feature.kind;
  }
  const low = rules.surfacePlates - rules.surfaceTolerancePlates;
  const high = rules.surfacePlates + rules.surfaceTolerancePlates;
  const ground = colors[0];
  for (let stud = 0; stud < rules.moduleStuds; stud++) {
    if (!within(plates[stud] ?? NO_TOP, low, high) || colors[stud] !== ground) return "other";
  }
  return "terrain";
}

function sameSamples(a: ModuleEdge, b: ModuleEdge): boolean {
  if (a.plates.length !== b.plates.length) return false;
  for (let i = 0; i < a.plates.length; i++) {
    if (a.plates[i] !== b.plates[i] || a.colors[i] !== b.colors[i]) return false;
  }
  return true;
}

export function edgesJoin(a: ModuleEdge, b: ModuleEdge): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "other" || sameSamples(a, b);
}

function facing(side: ModuleSide): {
  readonly side: ModuleSide;
  readonly dc: number;
  readonly dr: number;
} {
  switch (side) {
    case "minX":
      return { side: "maxX", dc: -1, dr: 0 };
    case "maxX":
      return { side: "minX", dc: 1, dr: 0 };
    case "minZ":
      return { side: "maxZ", dc: 0, dr: -1 };
    case "maxZ":
      return { side: "minZ", dc: 0, dr: 1 };
    default: {
      const unhandled: never = side;
      throw new Error(`unhandled side ${String(unhandled)}`);
    }
  }
}

function cellKey(column: number, row: number): string {
  return `${column},${row}`;
}

function sideIndex(side: ModuleSide): number {
  return MODULE_SIDES.indexOf(side);
}

export class ModuleGrid {
  private readonly cells = new Map<string, GridModule>();

  constructor(modules: ReadonlyArray<GridModule>) {
    for (const module of modules) this.cells.set(cellKey(module.column, module.row), module);
  }

  occupant(column: number, row: number): GridModule | null {
    return this.cells.get(cellKey(column, row)) ?? null;
  }

  private check(column: number, row: number, side: ModuleSide, edge: ModuleEdge): SideCheck {
    const across = facing(side);
    const neighbour = this.occupant(column + across.dc, row + across.dr);
    const other = neighbour?.edges[sideIndex(across.side)];
    if (!other) return { status: "open", facing: null };
    return { status: edgesJoin(edge, other) ? "joined" : "mismatch", facing: other.kind };
  }

  fit(column: number, row: number, edges: ReadonlyArray<ModuleEdge>): ModuleFit {
    const statuses = MODULE_SIDES.map((side, index) => {
      const edge = edges[index];
      return edge ? this.check(column, row, side, edge).status : "open";
    });
    return {
      joined: statuses.filter((status) => status === "joined").length,
      mismatched: statuses.filter((status) => status === "mismatch").length,
      open: statuses.filter((status) => status === "open").length,
      statuses,
    };
  }

  report(): ModuleJoinReport {
    const edges: ModuleEdgeReport[] = [];
    let joined = 0;
    let mismatched = 0;
    let open = 0;
    for (const module of this.cells.values()) {
      MODULE_SIDES.forEach((side, index) => {
        const edge = module.edges[index];
        if (!edge) return;
        const { status, facing: facingKind } = this.check(module.column, module.row, side, edge);
        edges.push({ module: module.id, side, kind: edge.kind, status, facing: facingKind });
        if (status === "open") open++;
        else if (side === "maxX" || side === "maxZ") {
          if (status === "joined") joined++;
          else mismatched++;
        }
      });
    }
    return { modules: this.cells.size, joined, mismatched, open, edges };
  }
}
