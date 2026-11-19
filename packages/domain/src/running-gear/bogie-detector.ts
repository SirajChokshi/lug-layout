import { compareExactRational, exactRationalFromFloat64, type ExactRational } from "@brr/math";
import type { SnapMating } from "../connect/mating.ts";
import {
  connectorOriginLdu,
  AXIS_FREE,
  AXIS_POS_Y,
  VECTOR_FLOATS,
  axisDimension,
  axisSign,
  type ConnectorTable,
} from "../connect/connector-table.ts";
import {
  IdentifiedPoint,
  MODEL_ROOT,
  SubmodelFrames,
  TRANSFORM_FLOATS,
  coordinatesAcross,
  identifyDirection,
  identifyPoint,
  type PartInstances,
} from "../connect/submodel-frames.ts";
import {
  MATE_PASS_MODEL,
  MATE_PASS_PART,
  MATE_PASS_SUBMODEL,
  type MatePairs,
} from "../connect/mate-pairs.ts";
import { wheelFreeHangingGroups, type HangingGroup } from "./hanging-groups.ts";
import { AxleHeights, commonFrame, supportPlane } from "./support-plane.ts";
import { UnionFind } from "./union-find.ts";
import type { DetectedWheelset } from "./wheelset-detector.ts";

const VERTICAL = 1;
const ROW = 4;
const TRANSLATION = 3;

function readsAcrossParts(mates: MatePairs, mate: number): boolean {
  const pass = mates.passOf(mate);
  switch (pass) {
    case MATE_PASS_MODEL:
    case MATE_PASS_SUBMODEL:
      return true;
    case MATE_PASS_PART:
      return false;
    default: {
      const unhandled: never = pass;
      throw new Error(`unhandled mate pass ${String(unhandled)}`);
    }
  }
}

export interface PivotEdge {
  readonly a: number;
  readonly b: number;
  readonly mates: ReadonlyArray<number>;
}

export interface SubAssembly {
  readonly instances: Uint32Array;
  readonly wheelsets: ReadonlyArray<number>;
}

export interface DetectedBogie {
  readonly subAssembly: number;
  readonly pivotMates: ReadonlyArray<number>;
  readonly carried: ReadonlyArray<number>;
  readonly pendants: ReadonlyArray<number>;
}

export interface UnidentifiedSupportPlane {
  readonly body: number;
  readonly wheelsets: readonly [number, number];
}

interface Classification {
  readonly subAssemblies: ReadonlyArray<SubAssembly>;
  readonly bogies: ReadonlyArray<DetectedBogie>;
  readonly bodies: ReadonlyArray<number>;
  readonly attachments: ReadonlyArray<number>;
  readonly spanningWheelsets: ReadonlyArray<number>;
}

export interface RunningGearPartition extends Classification {
  readonly subAssemblyOf: Int32Array;
  readonly edges: ReadonlyArray<PivotEdge>;
  readonly seated: Uint8Array;
  readonly unseatedBy: Int32Array;
  readonly unidentifiedSupportPlanes: ReadonlyArray<UnidentifiedSupportPlane>;
}

const NOT_UNSEATED = -1;

interface Edge {
  a: number;
  b: number;
  readonly mates: number[];
  readonly lineMate: number;
}

const REMOVED = -1;

function pairKey(a: number, b: number, count: number): number {
  return a < b ? a * count + b : b * count + a;
}

function normalize(sets: UnionFind, edges: ReadonlyArray<Edge>): void {
  for (const edge of edges) {
    edge.a = sets.find(edge.a);
    edge.b = sets.find(edge.b);
  }
}

function transformPoint(
  transform: Float64Array,
  part: ConnectorTable,
  c: number,
  row: number,
): number {
  const r = row * ROW;
  return (
    (transform[r] ?? 0) * connectorOriginLdu(part, c, 0) +
    (transform[r + 1] ?? 0) * connectorOriginLdu(part, c, 1) +
    (transform[r + 2] ?? 0) * connectorOriginLdu(part, c, 2) +
    (transform[r + TRANSLATION] ?? 0)
  );
}

export class BogieDetector {
  constructor(private readonly mating: SnapMating) {}

  private readonly transform = new Float64Array(TRANSFORM_FLOATS);
  private readonly point = new IdentifiedPoint();
  private readonly other = new IdentifiedPoint();

  partition(
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
    wheelsets: ReadonlyArray<DetectedWheelset>,
  ): RunningGearPartition {
    const frames = new SubmodelFrames(instances);
    const sets = new UnionFind(instances.count);
    const verticalFree = new Uint8Array(mates.count);
    for (let m = 0; m < mates.count; m++) {
      if (!readsAcrossParts(mates, m)) continue;
      if (this.freeAboutVertical(frames, instances, parts, mates, m)) {
        verticalFree[m] = 1;
        continue;
      }
      sets.union(mates.maleInstance[m] ?? 0, mates.femaleInstance[m] ?? 0);
    }
    const edges = this.edgesBetween(sets, mates, verticalFree, frames, instances, parts);
    const wheelsetInstances = wheelsets.flatMap((wheelset) => [...wheelset.memberInstances]);
    const contracted = new Map<number, number>();
    for (let changed = true; changed;) {
      changed = this.lock(sets, edges, frames, instances, parts, mates);
      changed =
        this.contract(
          sets,
          edges,
          wheelsetInstances,
          contracted,
          frames,
          instances,
          parts,
          mates,
        ) || changed;
    }
    const creditedRoot = (root: number): number => {
      let current = root;
      for (let next = contracted.get(current); next !== undefined; next = contracted.get(current)) {
        current = sets.find(next);
      }
      return current;
    };
    for (const edge of edges) {
      edge.a = sets.find(edge.a);
      edge.b = sets.find(edge.b);
    }
    const live = edges.filter((edge) => edge.a !== edge.b);
    const rootIndex = new Map<number, number>();
    const classifiedOf = new Int32Array(instances.count);
    const subAssemblyOf = new Int32Array(instances.count);
    const members: number[][] = [];
    const indexOf = (root: number): number => {
      let index = rootIndex.get(root);
      if (index === undefined) {
        index = members.length;
        rootIndex.set(root, index);
        members.push([]);
      }
      return index;
    };
    for (let i = 0; i < instances.count; i++) {
      const root = sets.find(i);
      classifiedOf[i] = contracted.has(root) ? -1 : indexOf(root);
    }
    for (let i = 0; i < instances.count; i++) {
      const index = indexOf(creditedRoot(sets.find(i)));
      members[index]?.push(i);
      subAssemblyOf[i] = index;
    }
    const pivotEdges: PivotEdge[] = live.map((edge) => ({
      a: rootIndex.get(edge.a) ?? 0,
      b: rootIndex.get(edge.b) ?? 0,
      mates: edge.mates,
    }));
    const heights = new AxleHeights(frames);
    const classifyWith = (counted: Uint8Array): Classification =>
      this.classify(
        members,
        classifiedOf,
        counted,
        pivotEdges,
        frames,
        heights,
        instances,
        parts,
        mates,
        wheelsets,
      );
    const counted = new Uint8Array(wheelsets.length).fill(1);
    const unseatedBy = new Int32Array(wheelsets.length).fill(NOT_UNSEATED);
    const unidentified = new Map<number, UnidentifiedSupportPlane>();
    let classes = classifyWith(counted);
    for (let unseated = true; unseated;) {
      unseated = false;
      for (const body of classes.bodies) {
        if (unidentified.has(body)) continue;
        const own = [
          ...(classes.subAssemblies[body]?.wheelsets ?? []),
          ...classes.bogies
            .filter((bogie) => bogie.carried.includes(body))
            .flatMap((bogie) => classes.subAssemblies[bogie.subAssembly]?.wheelsets ?? []),
        ];
        if (own.length === 0) continue;
        const plane = supportPlane(frames, heights, wheelsets, own);
        if (plane.unidentified) {
          unidentified.set(body, { body, wheelsets: plane.unidentified });
          continue;
        }
        own.forEach((w, k) => {
          if (plane.seated[k] === 1) return;
          counted[w] = 0;
          unseatedBy[w] = body;
          unseated = true;
        });
      }
      if (unseated) classes = classifyWith(counted);
    }
    return {
      ...classes,
      subAssemblyOf,
      edges: pivotEdges,
      seated: counted,
      unseatedBy,
      unidentifiedSupportPlanes: [...unidentified.values()],
    };
  }

  private classify(
    members: ReadonlyArray<ReadonlyArray<number>>,
    classifiedOf: Int32Array,
    counted: Uint8Array,
    pivotEdges: ReadonlyArray<PivotEdge>,
    frames: SubmodelFrames,
    heights: AxleHeights,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
    wheelsets: ReadonlyArray<DetectedWheelset>,
  ): Classification {
    const wheelsetsOf: number[][] = members.map(() => []);
    const spanningWheelsets: number[] = [];
    wheelsets.forEach((wheelset, w) => {
      if (counted[w] !== 1) return;
      const first = classifiedOf[wheelset.memberInstances[0] ?? 0] ?? -1;
      const together =
        first >= 0 && wheelset.memberInstances.every((i) => classifiedOf[i] === first);
      if (together) wheelsetsOf[first]?.push(w);
      else spanningWheelsets.push(w);
    });
    const subAssemblies: SubAssembly[] = members.map((list, s) => ({
      instances: Uint32Array.from(list),
      wheelsets: wheelsetsOf[s] ?? [],
    }));
    const hanging = wheelFreeHangingGroups(
      subAssemblies.length,
      pivotEdges,
      Int32Array.from(subAssemblies, (sub) => sub.wheelsets.length),
    );
    const bogies: DetectedBogie[] = [];
    const isBogie = new Uint8Array(subAssemblies.length);
    for (let s = 0; s < subAssemblies.length; s++) {
      const bogie = this.bogieOf(
        s,
        subAssemblies,
        pivotEdges,
        hanging[s] ?? [],
        classifiedOf,
        frames,
        heights,
        instances,
        parts,
        mates,
        wheelsets,
      );
      if (bogie) {
        bogies.push(bogie);
        isBogie[s] = 1;
      }
    }
    const carriedByBogie = new Uint8Array(subAssemblies.length);
    for (const bogie of bogies) for (const s of bogie.carried) carriedByBogie[s] = 1;
    const bodies: number[] = [];
    const attachments: number[] = [];
    for (let s = 0; s < subAssemblies.length; s++) {
      if (isBogie[s] === 1) continue;
      const sub = subAssemblies[s];
      if ((sub?.wheelsets.length ?? 0) > 0 || carriedByBogie[s] === 1) bodies.push(s);
      else attachments.push(s);
    }
    return { subAssemblies, bogies, bodies, attachments, spanningWheelsets };
  }

  private connectorAxis(
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    instance: number,
    connector: number,
  ): number {
    const part = parts[instances.partIndex[instance] ?? -1];
    if (!part) return AXIS_FREE;
    frames.relate(instance, MODEL_ROOT, this.transform);
    const code = part.axis[connector] ?? AXIS_FREE;
    const v = connector * VECTOR_FLOATS;
    if (code === AXIS_FREE) {
      return identifyDirection(
        this.transform,
        part.axisFree[v] ?? 0,
        part.axisFree[v + 1] ?? 0,
        part.axisFree[v + 2] ?? 0,
      );
    }
    const dimension = axisDimension(code);
    const sign = axisSign(code);
    return identifyDirection(
      this.transform,
      dimension === 0 ? sign : 0,
      dimension === 1 ? sign : 0,
      dimension === 2 ? sign : 0,
    );
  }

  private freeAboutVertical(
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
    m: number,
  ): boolean {
    const male = mates.maleInstance[m] ?? 0;
    const maleConnector = mates.maleConnector[m] ?? 0;
    const malePart = parts[instances.partIndex[male] ?? -1];
    const femalePart = parts[instances.partIndex[mates.femaleInstance[m] ?? 0] ?? -1];
    if (!malePart || !femalePart) return false;
    const freedom = this.mating.freedom(
      malePart.shape[maleConnector] ?? 0,
      femalePart.shape[mates.femaleConnector[m] ?? 0] ?? 0,
      mates.mateOffset[m] ?? 0,
      mates.mateAxis[m] ?? 0,
    );
    if (freedom.freeAboutVertical) return true;
    if (!freedom.spins) return false;
    const axis = this.connectorAxis(frames, instances, parts, male, maleConnector);
    return axis !== AXIS_FREE && axisDimension(axis) === VERTICAL;
  }

  private pivotPoint(
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    instance: number,
    connector: number,
    frame: number,
    out: IdentifiedPoint,
  ): boolean {
    const part = parts[instances.partIndex[instance] ?? -1];
    if (!part || !frames.relate(instance, frame, this.transform)) return false;
    return identifyPoint(
      this.transform,
      connectorOriginLdu(part, connector, 0),
      connectorOriginLdu(part, connector, 1),
      connectorOriginLdu(part, connector, 2),
      coordinatesAcross(AXIS_POS_Y),
      out,
    );
  }

  sharePivotLine(
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
    pivotMates: ReadonlyArray<number>,
  ): boolean {
    const [first, ...rest] = pivotMates;
    if (first === undefined) return false;
    return rest.every((m) => this.sameLine(frames, instances, parts, mates, m, first));
  }

  joints(
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
    rows: ReadonlyArray<number>,
  ): number[] {
    const kept: number[] = [];
    for (const m of rows) {
      if (!kept.some((k) => this.sameJoint(frames, instances, parts, mates, k, m))) kept.push(m);
    }
    return kept;
  }

  private sameJoint(
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
    m: number,
    n: number,
  ): boolean {
    if (m === n) return true;
    const mMale = mates.maleInstance[m] ?? 0;
    const mFemale = mates.femaleInstance[m] ?? 0;
    const nMale = mates.maleInstance[n] ?? 0;
    const nFemale = mates.femaleInstance[n] ?? 0;
    const samePair =
      (mMale === nMale && mFemale === nFemale) || (mMale === nFemale && mFemale === nMale);
    return samePair && this.sameLine(frames, instances, parts, mates, m, n);
  }

  private sameLine(
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
    m: number,
    n: number,
  ): boolean {
    const a = mates.maleInstance[m] ?? 0;
    const b = mates.maleInstance[n] ?? 0;
    const frame = frames.lowestCommonFrame(a, b);
    const first = this.pivotPoint(
      frames,
      instances,
      parts,
      a,
      mates.maleConnector[m] ?? 0,
      frame,
      this.point,
    );
    const second = this.pivotPoint(
      frames,
      instances,
      parts,
      b,
      mates.maleConnector[n] ?? 0,
      frame,
      this.other,
    );
    if (!first || !second) return false;
    return (
      this.point.sixteenths[0] === this.other.sixteenths[0] &&
      this.point.sixteenths[2] === this.other.sixteenths[2]
    );
  }

  private edgesBetween(
    sets: UnionFind,
    mates: MatePairs,
    verticalFree: Uint8Array,
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
  ): Edge[] {
    const edges: Edge[] = [];
    const byPair = new Map<number, Edge[]>();
    for (let m = 0; m < mates.count; m++) {
      if (verticalFree[m] !== 1) continue;
      const a = sets.find(mates.maleInstance[m] ?? 0);
      const b = sets.find(mates.femaleInstance[m] ?? 0);
      if (a === b) continue;
      const key = pairKey(a, b, instances.count);
      const between = byPair.get(key) ?? [];
      const existing = between.find((edge) =>
        this.sameLine(frames, instances, parts, mates, edge.lineMate, m),
      );
      if (existing) {
        existing.mates.push(m);
        continue;
      }
      const edge: Edge = { a, b, mates: [m], lineMate: m };
      between.push(edge);
      byPair.set(key, between);
      edges.push(edge);
    }
    return edges;
  }

  private lock(
    sets: UnionFind,
    edges: Edge[],
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
  ): boolean {
    normalize(sets, edges);
    const byPair = new Map<number, Edge[]>();
    for (const edge of edges) {
      if (edge.a === edge.b) continue;
      const key = pairKey(edge.a, edge.b, instances.count);
      const between = byPair.get(key);
      if (between) between.push(edge);
      else byPair.set(key, [edge]);
    }
    let changed = false;
    for (const between of byPair.values()) {
      const first = between[0];
      if (!first || between.length < 2) continue;
      const distinct = between.some(
        (edge) => !this.sameLine(frames, instances, parts, mates, edge.lineMate, first.lineMate),
      );
      if (!distinct) continue;
      sets.union(first.a, first.b);
      changed = true;
    }
    if (changed) normalize(sets, edges);
    return changed;
  }

  private contract(
    sets: UnionFind,
    edges: Edge[],
    wheelsetInstances: ReadonlyArray<number>,
    contracted: Map<number, number>,
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
  ): boolean {
    normalize(sets, edges);
    const holding = new Set(wheelsetInstances.map((instance) => sets.find(instance)));
    const incidence = new Map<number, Edge[]>();
    for (const edge of edges) {
      if (edge.a === edge.b) continue;
      for (const end of [edge.a, edge.b]) {
        const list = incidence.get(end);
        if (list) list.push(edge);
        else incidence.set(end, [edge]);
      }
    }
    for (const root of [...incidence.keys()].toSorted((x, y) => x - y)) {
      if (contracted.has(root) || holding.has(root)) continue;
      const incident = incidence.get(root) ?? [];
      const neighbours = [...new Set(incident.map((edge) => (edge.a === root ? edge.b : edge.a)))];
      if (neighbours.length < 2) continue;
      const first = incident[0];
      if (!first) continue;
      const oneLine = incident.every((edge) =>
        this.sameLine(frames, instances, parts, mates, edge.lineMate, first.lineMate),
      );
      if (!oneLine) continue;
      contracted.set(
        root,
        this.highestNeighbour(sets, incident, root, frames, instances, parts, mates),
      );
      for (const edge of incident) {
        if (edge.a === root) edge.a = REMOVED;
        if (edge.b === root) edge.b = REMOVED;
      }
      for (let x = 0; x < neighbours.length; x++) {
        for (let y = x + 1; y < neighbours.length; y++) {
          const a = neighbours[x] ?? 0;
          const b = neighbours[y] ?? 0;
          const via = incident
            .filter((edge) => edge.a === a || edge.b === a || edge.a === b || edge.b === b)
            .flatMap((edge) => edge.mates);
          edges.push({ a, b, mates: via, lineMate: first.lineMate });
        }
      }
      for (let k = edges.length - 1; k >= 0; k--) {
        const edge = edges[k];
        if (edge && (edge.a === REMOVED || edge.b === REMOVED)) edges.splice(k, 1);
      }
      return true;
    }
    return false;
  }

  private highestNeighbour(
    sets: UnionFind,
    incident: ReadonlyArray<Edge>,
    root: number,
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
  ): number {
    let best = -1;
    let bestHeight: ExactRational | null = null;
    for (const edge of incident) {
      const neighbour = edge.a === root ? edge.b : edge.a;
      for (const m of edge.mates) {
        const male = mates.maleInstance[m] ?? 0;
        const ownIsMale = sets.find(male) === neighbour;
        const instance = ownIsMale ? male : (mates.femaleInstance[m] ?? 0);
        if (sets.find(instance) !== neighbour) continue;
        const connector = ownIsMale
          ? (mates.maleConnector[m] ?? 0)
          : (mates.femaleConnector[m] ?? 0);
        const part = parts[instances.partIndex[instance] ?? -1];
        if (!part) continue;
        frames.relate(instance, MODEL_ROOT, this.transform);
        const height = exactRationalFromFloat64(
          transformPoint(this.transform, part, connector, VERTICAL),
        );
        const order = bestHeight === null ? 1 : compareExactRational(height, bestHeight);
        if (order > 0 || (order === 0 && neighbour < best)) {
          best = neighbour;
          bestHeight = height;
        }
      }
    }
    return best;
  }

  private bogieOf(
    s: number,
    subAssemblies: ReadonlyArray<SubAssembly>,
    edges: ReadonlyArray<PivotEdge>,
    hanging: ReadonlyArray<HangingGroup>,
    classifiedOf: Int32Array,
    frames: SubmodelFrames,
    heights: AxleHeights,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
    wheelsets: ReadonlyArray<DetectedWheelset>,
  ): DetectedBogie | null {
    const sub = subAssemblies[s];
    if (!sub || sub.wheelsets.length === 0) return null;
    const pendantGroups = hanging.filter((group) =>
      this.outboardPendant(sub, group, edges, frames, heights, instances, parts, mates, wheelsets),
    );
    const peeled = new Set(pendantGroups.flatMap((group) => group.joins));
    const incident = edges.filter((edge, e) => (edge.a === s || edge.b === s) && !peeled.has(e));
    if (incident.length === 0) return null;
    const pivotMates = incident.flatMap((edge) => edge.mates);
    const firstMate = pivotMates[0];
    if (firstMate === undefined) return null;
    const oneLine = pivotMates.every((m) =>
      this.sameLine(frames, instances, parts, mates, m, firstMate),
    );
    if (!oneLine) return null;
    for (const m of pivotMates) {
      const male = mates.maleInstance[m] ?? 0;
      const ownIsMale = classifiedOf[male] === s;
      const instance = ownIsMale ? male : (mates.femaleInstance[m] ?? 0);
      if (classifiedOf[instance] !== s) continue;
      const connector = ownIsMale ? (mates.maleConnector[m] ?? 0) : (mates.femaleConnector[m] ?? 0);
      if (this.connectorAxis(frames, instances, parts, instance, connector) !== AXIS_POS_Y)
        return null;
    }
    if (!this.pivotWithinWheelbase(sub, firstMate, frames, instances, parts, mates, wheelsets))
      return null;
    const carried = [...new Set(incident.map((edge) => (edge.a === s ? edge.b : edge.a)))];
    const pendants = pendantGroups.flatMap((group) => group.members).toSorted((a, b) => a - b);
    return { subAssembly: s, pivotMates, carried, pendants };
  }

  private outboardPendant(
    sub: SubAssembly,
    group: HangingGroup,
    edges: ReadonlyArray<PivotEdge>,
    frames: SubmodelFrames,
    heights: AxleHeights,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
    wheelsets: ReadonlyArray<DetectedWheelset>,
  ): boolean {
    const join = group.joins.flatMap((e) => edges[e]?.mates ?? []);
    const first = join[0];
    if (first === undefined) return false;
    if (!join.every((m) => this.sameLine(frames, instances, parts, mates, m, first))) return false;
    const own = sub.wheelsets.flatMap((w) => {
      const wheelset = wheelsets[w];
      return wheelset ? [wheelset] : [];
    });
    const lead = own[0];
    if (!lead || own.some((w) => w.modelDimension !== lead.modelDimension)) return false;
    const travel = lead.modelDimension === 0 ? 2 : 0;
    const male = mates.maleInstance[first] ?? 0;
    const female = mates.femaleInstance[first] ?? 0;
    const part = parts[instances.partIndex[male] ?? -1];
    if (!part) return false;
    let frame = commonFrame(frames, frames.frameOf(male), frames.frameOf(female));
    for (const w of own) frame = commonFrame(frames, frame, frames.frameOf(w.axleInstance));
    const connector = mates.maleConnector[first] ?? 0;
    const pivot = heights.along(
      male,
      [0, 1, 2].map((k) => connectorOriginLdu(part, connector, k)),
      frame,
      travel,
    );
    if (pivot === null) return false;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const w of own) {
      const at = heights.along(w.axleInstance, w.axlePoint, frame, travel);
      if (at === null) return false;
      low = Math.min(low, at);
      high = Math.max(high, at);
    }
    return pivot < low || pivot > high;
  }

  private pivotWithinWheelbase(
    sub: SubAssembly,
    pivotMate: number,
    frames: SubmodelFrames,
    instances: PartInstances,
    parts: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
    wheelsets: ReadonlyArray<DetectedWheelset>,
  ): boolean {
    const first = wheelsets[sub.wheelsets[0] ?? -1];
    if (!first) return false;
    const travel = first.modelDimension === 0 ? 2 : 0;
    const positions = sub.wheelsets.map((w) => wheelsets[w]?.axisLine[travel] ?? 0);
    const low = Math.min(...positions);
    const high = Math.max(...positions);
    if (low === high) return true;
    const male = mates.maleInstance[pivotMate] ?? 0;
    const part = parts[instances.partIndex[male] ?? -1];
    if (!part) return false;
    frames.relate(male, MODEL_ROOT, this.transform);
    const pivot = transformPoint(this.transform, part, mates.maleConnector[pivotMate] ?? 0, travel);
    return low <= pivot && pivot <= high;
  }
}
