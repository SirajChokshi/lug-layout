import { PLATE_LDU, STUD_LDU, lduFromMm, mmFromLdu, type Rot90 } from "@brr/math";
import type {
  PartCount,
  EdgeFeature,
  ItemSpec,
  ModuleProfile,
  ModuleProfileId,
  ModuleStandards,
} from "./item-spec.ts";
import {
  rectsOverlap,
  regionOriginX,
  regionOriginZ,
  type LduRect,
  type PlanRegion,
} from "./plan-region.ts";
import { resolveLines, type CatalogSystem, type Crosswalk } from "../bom/catalog-ids.ts";
import type {
  PlacementKey,
  PlanCheck,
  PlanIssue,
  PlanPlacement,
  PlanRuleId,
} from "./plan-rules.ts";
import {
  trackBomLines,
  trackFootprints,
  trackInRegion,
  trackIssues,
  type TrackInput,
} from "./track-checks.ts";
import { placedFeature, placedRect } from "./placed-geometry.ts";
import {
  accessibleEdges,
  crossesInterior,
  segmentPointDistance,
  tableEdges,
  type Segment,
} from "./table-edges.ts";

export const DEFAULT_MAX_REACH_MM = 700;

export interface BuildablePlacement extends PlanPlacement {
  readonly x: number;
  readonly z: number;
  readonly rot: Rot90;
}

export interface BuildableSettings {
  readonly profile: ModuleProfileId;
  readonly maxReachMm: number;
}

export type BuildableVerdict = "buildable" | "draft" | "empty";

export interface CatalogIds {
  readonly part: string | null;
  readonly color: number | null;
}

export interface PlanBomEntry extends PartCount {
  readonly substructure: number;
  readonly rebrickable: CatalogIds;
  readonly bricklink: CatalogIds;
}

export interface BuildableCatalog {
  readonly specs: ReadonlyMap<string, ItemSpec>;
  readonly standards: ModuleStandards;
  readonly crosswalk: Crosswalk;
}

const CATALOG_SYSTEMS: ReadonlyArray<CatalogSystem> = ["rebrickable", "bricklink"];
const SYSTEM_NAMES: Readonly<Record<CatalogSystem, string>> = {
  rebrickable: "Rebrickable",
  bricklink: "BrickLink",
};
const LISTED_UNMAPPED = 8;

export function placementId(key: PlacementKey): string {
  return `${key.chunkKey}:${key.slot}`;
}

export interface PlacementBom {
  readonly key: PlacementKey;
  readonly label: string;
  readonly parts: number;
  readonly substructure: number;
}

export interface PlanBom {
  readonly lines: ReadonlyArray<PlanBomEntry>;
  readonly placements: ReadonlyArray<PlacementBom>;
  readonly totalParts: number;
}

export interface BuildableReport {
  readonly regionId: string;
  readonly profile: ModuleProfileId;
  readonly verdict: BuildableVerdict;
  readonly errors: number;
  readonly warnings: number;
  readonly issues: ReadonlyArray<PlanIssue>;
  readonly bom: PlanBom;
}

interface Placed {
  readonly placement: BuildablePlacement;
  readonly spec: ItemSpec;
  readonly ground: ReadonlyArray<LduRect>;
  readonly module: LduRect | null;
  readonly joins: ReadonlyArray<EdgeFeature>;
  readonly roadways: ReadonlyArray<EdgeFeature>;
  readonly recipeModule: boolean;
}

interface SharedEdge {
  readonly horizontal: boolean;
  readonly line: number;
  readonly from: number;
  readonly to: number;
}

function issue(
  rule: PlanRuleId,
  placements: ReadonlyArray<PlacementKey>,
  message: string,
): PlanIssue {
  return {
    rule,
    severity: "error",
    placements,
    message,
    overhangMm: 0,
    nearestTableMm: 0,
    offTableMm2: 0,
  };
}

function recipeJoins(module: LduRect, profile: ModuleProfile): EdgeFeature[] {
  const recipe = profile.recipe;
  if (!recipe) return [];
  const level = profile.joinLevelPlates * PLATE_LDU;
  return recipe.edgeJoinCells.flatMap(([first, last]) => {
    const from = first * STUD_LDU;
    const to = (last + 1) * STUD_LDU;
    return [
      {
        ax: module.minX + from,
        az: module.minZ,
        bx: module.minX + to,
        bz: module.minZ,
        levelLdu: level,
      },
      {
        ax: module.minX + from,
        az: module.maxZ,
        bx: module.minX + to,
        bz: module.maxZ,
        levelLdu: level,
      },
      {
        ax: module.minX,
        az: module.minZ + from,
        bx: module.minX,
        bz: module.minZ + to,
        levelLdu: level,
      },
      {
        ax: module.maxX,
        az: module.minZ + from,
        bx: module.maxX,
        bz: module.minZ + to,
        levelLdu: level,
      },
    ];
  });
}

function isRecipeModule(spec: ItemSpec, profile: ModuleProfile | null): boolean {
  const recipe = profile?.recipe;
  if (!recipe || !spec.module || spec.joins.length > 0) return false;
  return spec.bom.length === 1 && spec.bom[0]?.part === recipe.groundPart;
}

function place(
  placement: BuildablePlacement,
  spec: ItemSpec,
  profile: ModuleProfile | null,
): Placed {
  const { x, z, rot } = placement;
  const module = spec.module ? placedRect(spec.module, x, z, rot) : null;
  const recipeModule = isRecipeModule(spec, profile);
  const joins =
    recipeModule && module && profile
      ? recipeJoins(module, profile)
      : spec.joins.map((join) => placedFeature(join, x, z, rot));
  return {
    placement,
    spec,
    ground: spec.ground.map((rect) => placedRect(rect, x, z, rot)),
    module,
    joins,
    roadways: spec.roadways.map((road) => placedFeature(road, x, z, rot)),
    recipeModule,
  };
}

function sharedEdge(a: LduRect, b: LduRect): SharedEdge | null {
  const overlapX = [Math.max(a.minX, b.minX), Math.min(a.maxX, b.maxX)] as const;
  const overlapZ = [Math.max(a.minZ, b.minZ), Math.min(a.maxZ, b.maxZ)] as const;
  if ((a.maxZ === b.minZ || b.maxZ === a.minZ) && overlapX[1] > overlapX[0]) {
    return {
      horizontal: true,
      line: a.maxZ === b.minZ ? a.maxZ : a.minZ,
      from: overlapX[0],
      to: overlapX[1],
    };
  }
  if ((a.maxX === b.minX || b.maxX === a.minX) && overlapZ[1] > overlapZ[0]) {
    return {
      horizontal: false,
      line: a.maxX === b.minX ? a.maxX : a.minX,
      from: overlapZ[0],
      to: overlapZ[1],
    };
  }
  return null;
}

type Span = readonly [number, number, number];

function spansOn(features: ReadonlyArray<EdgeFeature>, edge: SharedEdge): Span[] {
  const spans: Span[] = [];
  for (const f of features) {
    const onLine = edge.horizontal
      ? f.az === edge.line && f.bz === edge.line
      : f.ax === edge.line && f.bx === edge.line;
    if (!onLine) continue;
    const a = edge.horizontal ? Math.min(f.ax, f.bx) : Math.min(f.az, f.bz);
    const b = edge.horizontal ? Math.max(f.ax, f.bx) : Math.max(f.az, f.bz);
    if (b <= edge.from || a >= edge.to) continue;
    spans.push([a, b, f.levelLdu]);
  }
  return spans.toSorted((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
}

function sameSpans(a: ReadonlyArray<Span>, b: ReadonlyArray<Span>): boolean {
  return (
    a.length === b.length &&
    a.every((span, i) => {
      const other = b[i];
      return (
        other !== undefined && span[0] === other[0] && span[1] === other[1] && span[2] === other[2]
      );
    })
  );
}

function describeSpans(spans: ReadonlyArray<Span>, edge: SharedEdge): string {
  if (spans.length === 0) return "none";
  return spans
    .map(([a, b, level]) => {
      const first = (a - edge.from) / STUD_LDU;
      const last = (b - edge.from) / STUD_LDU - 1;
      const cells = first === last ? `${first}` : `${first}–${last}`;
      return level === 0 ? cells : `${cells} (${level / PLATE_LDU} plates up)`;
    })
    .join(", ");
}

function edgeName(edge: SharedEdge): string {
  const axis = edge.horizontal ? "z" : "x";
  return `the edge at ${axis} = ${edge.line} LDU`;
}

function signedOffset(value: number, side: number): number {
  const offset = ((value % side) + side) % side;
  return offset * 2 >= side ? offset - side : offset;
}

function moduleIssues(
  placed: ReadonlyArray<Placed>,
  region: PlanRegion,
  profile: ModuleProfile,
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const side = profile.moduleStuds * STUD_LDU;
  const originX = regionOriginX(region);
  const originZ = regionOriginZ(region);
  const modules = placed.filter((p) => p.module !== null);
  for (const item of modules) {
    const module = item.module;
    if (!module) continue;
    const offX = signedOffset(module.minX - originX, side);
    const offZ = signedOffset(module.minZ - originZ, side);
    if (offX !== 0 || offZ !== 0) {
      issues.push(
        issue(
          "moduleGrid",
          [item.placement.key],
          `${item.placement.label} is off the ${profile.moduleStuds}-stud ${profile.id} module grid by ${offX / STUD_LDU} studs in x and ${offZ / STUD_LDU} in z.`,
        ),
      );
    }
  }
  for (let i = 0; i < modules.length; i++) {
    for (let j = i + 1; j < modules.length; j++) {
      const a = modules[i];
      const b = modules[j];
      if (!a?.module || !b?.module) continue;
      const edge = sharedEdge(a.module, b.module);
      if (!edge) continue;
      const spansA = spansOn(a.joins, edge);
      const spansB = spansOn(b.joins, edge);
      const required = a.recipeModule || b.recipeModule;
      if (sameSpans(spansA, spansB) && (spansA.length > 0 || !required)) continue;
      issues.push(
        issue(
          "moduleJoin",
          [a.placement.key, b.placement.key],
          `${a.placement.label} and ${b.placement.label} meet at ${edgeName(edge)}, but their Technic joins don't line up. Cells counted from the low end: ${a.spec.label} has ${describeSpans(spansA, edge)}; ${b.spec.label} has ${describeSpans(spansB, edge)}.`,
        ),
      );
    }
  }
  return issues;
}

function roadIssues(placed: ReadonlyArray<Placed>): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (!a || !b || (a.roadways.length === 0 && b.roadways.length === 0)) continue;
      for (const groundA of a.ground) {
        for (const groundB of b.ground) {
          const edge = sharedEdge(groundA, groundB);
          if (!edge) continue;
          const spansA = spansOn(a.roadways, edge);
          const spansB = spansOn(b.roadways, edge);
          if (sameSpans(spansA, spansB)) continue;
          issues.push(
            issue(
              "roadJoin",
              [a.placement.key, b.placement.key],
              `The road doesn't continue across ${edgeName(edge)}: roadway cells on ${a.spec.label} are ${describeSpans(spansA, edge)}; on ${b.spec.label} they are ${describeSpans(spansB, edge)}.`,
            ),
          );
        }
      }
    }
  }
  return issues;
}

function overlapIssues(placed: ReadonlyArray<Placed>): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (!a || !b) continue;
      const clash = a.ground.some((ga) => b.ground.some((gb) => rectsOverlap(ga, gb)));
      if (!clash) continue;
      issues.push(
        issue(
          "overlap",
          [a.placement.key, b.placement.key],
          `${a.placement.label} and ${b.placement.label} both need the same baseplate area.`,
        ),
      );
    }
  }
  return issues;
}

function seamIssues(placed: ReadonlyArray<Placed>, check: PlanCheck): PlanIssue[] {
  const { seams } = tableEdges(check.tables.map((t) => t.surface));
  const issues: PlanIssue[] = [];
  for (const item of placed) {
    const crossed = seams.filter((seam) => crossesInterior(seam, item.placement.box));
    const names = [
      ...new Set(
        crossed.map((seam) =>
          seam.tables.map((t) => `"${check.tables[t]?.name ?? t}"`).join(" and "),
        ),
      ),
    ];
    if (names.length === 0) continue;
    issues.push(
      issue(
        "seam",
        [item.placement.key],
        `${item.placement.label} straddles the seam between tables ${names.join("; ")}. Seams must fall on module boundaries.`,
      ),
    );
  }
  return issues;
}

function covered(check: PlanCheck, x: number, z: number): boolean {
  return check.tables.some(
    (t) => x >= t.surface.minX && x <= t.surface.maxX && z >= t.surface.minZ && z <= t.surface.maxZ,
  );
}

function farthestFromEdges(box: LduRect, check: PlanCheck, edges: ReadonlyArray<Segment>): number {
  let farthest = 0;
  const half = STUD_LDU / 2;
  for (let z = Math.floor(box.minZ / STUD_LDU) * STUD_LDU; z < box.maxZ; z += STUD_LDU) {
    for (let x = Math.floor(box.minX / STUD_LDU) * STUD_LDU; x < box.maxX; x += STUD_LDU) {
      const px = Math.min(box.maxX, Math.max(box.minX, x + half));
      const pz = Math.min(box.maxZ, Math.max(box.minZ, z + half));
      if (!covered(check, px, pz)) continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (const edge of edges) nearest = Math.min(nearest, segmentPointDistance(edge, px, pz));
      farthest = Math.max(farthest, nearest);
    }
  }
  return farthest;
}

function reachIssues(
  placed: ReadonlyArray<Placed>,
  check: PlanCheck,
  maxReachMm: number,
): PlanIssue[] {
  const { exterior } = tableEdges(check.tables.map((t) => t.surface));
  const edges = accessibleEdges(exterior, check.room, check.obstacles);
  const limit = lduFromMm(maxReachMm);
  const issues: PlanIssue[] = [];
  for (const item of placed) {
    const farthest =
      edges.length === 0
        ? Number.POSITIVE_INFINITY
        : farthestFromEdges(item.placement.box, check, edges);
    if (farthest <= limit) continue;
    const message =
      edges.length === 0
        ? `${item.placement.label} can't be reached: every table edge is against a wall or an obstacle.`
        : `${item.placement.label} is out of reach: part of it is ${Math.round(mmFromLdu(farthest))} mm from the nearest free table edge (limit ${maxReachMm} mm, sampled per stud).`;
    issues.push(issue("reach", [item.placement.key], message));
  }
  return issues;
}

function catalogIds(line: PartCount, crosswalk: Crosswalk, system: CatalogSystem): CatalogIds {
  return {
    part: crosswalk.parts.get(line.part)?.[system] ?? null,
    color:
      line.ldrawColor === null ? null : (crosswalk.colors.get(line.ldrawColor)?.[system] ?? null),
  };
}

function isMapped(entry: PlanBomEntry, system: CatalogSystem): boolean {
  const ids = entry[system];
  return ids.part !== null && (entry.ldrawColor === null || ids.color !== null);
}

function lineKey(line: PartCount): string {
  return `${line.part} ${line.ldrawColor ?? "any"}`;
}

function describeLine(entry: PlanBomEntry, system: CatalogSystem): string {
  const ids = entry[system];
  const missing =
    ids.part === null
      ? entry.ldrawColor !== null && ids.color === null
        ? "part and colour"
        : "part"
      : "colour";
  const color = entry.ldrawColor === null ? "any colour" : `colour ${entry.ldrawColor}`;
  return `${entry.part.replace("ldraw:", "")} in ${color} ×${entry.quantity} (no ${missing})`;
}

function resolvedKeys(line: PartCount, crosswalk: Crosswalk): string[] {
  const { ldrawColor } = line;
  if (ldrawColor === null) return [lineKey(line)];
  return resolveLines([{ ...line, ldrawColor }], crosswalk).map(lineKey);
}

function mappingIssues(
  placed: ReadonlyArray<Placed>,
  bom: PlanBom,
  crosswalk: Crosswalk,
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const system of CATALOG_SYSTEMS) {
    const unmapped = bom.lines.filter((entry) => !isMapped(entry, system));
    if (unmapped.length === 0) continue;
    const keys = new Set(unmapped.map(lineKey));
    const holders = placed
      .filter((item) =>
        item.spec.bom.some((line) => resolvedKeys(line, crosswalk).some((key) => keys.has(key))),
      )
      .map((item) => item.placement.key);
    const parts = unmapped.reduce((sum, entry) => sum + entry.quantity, 0);
    const listed = unmapped.slice(0, LISTED_UNMAPPED).map((entry) => describeLine(entry, system));
    const more =
      unmapped.length > LISTED_UNMAPPED
        ? `, and ${unmapped.length - LISTED_UNMAPPED} more lines`
        : "";
    issues.push(
      issue(
        "bomMapping",
        holders,
        `${parts} ${parts === 1 ? "part" : "parts"} in ${unmapped.length} ${unmapped.length === 1 ? "line" : "lines"} can't be bought on ${SYSTEM_NAMES[system]}: ${listed.join("; ")}${more}.`,
      ),
    );
  }
  return issues;
}

function planBom(
  placed: ReadonlyArray<Placed>,
  profile: ModuleProfile | null,
  crosswalk: Crosswalk,
  track: ReadonlyArray<PartCount>,
): PlanBom {
  const lines = new Map<
    string,
    {
      part: string;
      ldrawColor: number | null;
      quantity: number;
      substructure: number;
      rebrickable: CatalogIds;
      bricklink: CatalogIds;
    }
  >();
  const add = (line: PartCount, substructure: boolean): void => {
    const { ldrawColor } = line;
    if (ldrawColor !== null) {
      for (const resolved of resolveLines([{ ...line, ldrawColor }], crosswalk)) {
        addResolved(resolved, substructure);
      }
      return;
    }
    addResolved(line, substructure);
  };
  const addResolved = (line: PartCount, substructure: boolean): void => {
    const key = `${line.part} ${line.ldrawColor ?? "any"}`;
    const entry = lines.get(key) ?? {
      part: line.part,
      ldrawColor: line.ldrawColor,
      quantity: 0,
      substructure: 0,
      rebrickable: catalogIds(line, crosswalk, "rebrickable"),
      bricklink: catalogIds(line, crosswalk, "bricklink"),
    };
    entry.quantity += line.quantity;
    if (substructure) entry.substructure += line.quantity;
    lines.set(key, entry);
  };
  const placements: PlacementBom[] = [];
  for (const item of placed) {
    const recipe = item.recipeModule ? (profile?.recipe ?? null) : null;
    for (const line of item.spec.bom) add(line, false);
    for (const line of recipe?.substructure ?? []) add(line, true);
    placements.push({
      key: item.placement.key,
      label: item.placement.label,
      parts: item.spec.bom.reduce((sum, line) => sum + line.quantity, 0),
      substructure: (recipe?.substructure ?? []).reduce((sum, line) => sum + line.quantity, 0),
    });
  }
  for (const line of track) add(line, false);
  const sorted = [...lines.values()].toSorted(
    (a, b) =>
      a.part.localeCompare(b.part, "en", { numeric: true }) ||
      (a.ldrawColor ?? -1) - (b.ldrawColor ?? -1),
  );
  return {
    lines: sorted,
    placements,
    totalParts: sorted.reduce((sum, line) => sum + line.quantity, 0),
  };
}

export function checkBuildable(
  region: PlanRegion,
  check: PlanCheck,
  placements: ReadonlyArray<BuildablePlacement>,
  catalog: BuildableCatalog,
  settings: BuildableSettings,
  track: TrackInput | null,
): BuildableReport {
  const { standards, crosswalk } = catalog;
  const profile =
    settings.profile === "free"
      ? null
      : (standards.profiles.find((p) => p.id === settings.profile) ?? null);
  const inside = new Set(check.inside.map(placementId));
  const placed: Placed[] = [];
  for (const placement of placements) {
    if (!inside.has(placementId(placement.key))) continue;
    const spec = catalog.specs.get(placement.ref);
    if (spec) placed.push(place(placement, spec, profile));
  }
  const issues: PlanIssue[] = [
    ...check.issues,
    ...overlapIssues(placed),
    ...seamIssues(placed, check),
    ...reachIssues(placed, check, settings.maxReachMm),
    ...(profile ? moduleIssues(placed, region, profile) : []),
    ...roadIssues(placed),
  ];
  const trackInPlan = track ? trackInRegion(trackFootprints(track), check.room) : [];
  if (track) issues.push(...trackIssues(region, check, track, trackInPlan));
  const bom = planBom(placed, profile, crosswalk, trackBomLines(trackInPlan));
  issues.push(...mappingIssues(placed, bom, crosswalk));
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  const verdict: BuildableVerdict =
    placed.length + trackInPlan.length === 0 && errors === 0
      ? "empty"
      : errors === 0 && warnings === 0
        ? "buildable"
        : "draft";
  return {
    regionId: region.id,
    profile: settings.profile,
    verdict,
    errors,
    warnings,
    issues,
    bom,
  };
}
