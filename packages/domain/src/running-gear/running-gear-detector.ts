import { formatExactRational } from "@brr/math";
import type {
  ConnectorMate,
  ConnectorRef,
  ModelVehicle,
  UnreadRollingBands,
  UnresolvedRunningGear,
  UnresolvedRunningGearReason,
  VehicleBogie,
  VehicleCoupling,
  VehicleGuide,
  VehicleWheelset,
} from "@brr/schema/bundle";
import {
  connectorOriginLdu,
  AXIS_FREE,
  VECTOR_FLOATS,
  axisDimension,
  axisSign,
  type ConnectorTable,
} from "../connect/connector-table.ts";
import {
  MODEL_ROOT,
  SubmodelFrames,
  TRANSFORM_FLOATS,
  type PartInstances,
} from "../connect/submodel-frames.ts";
import type { MatePairs } from "../connect/mate-pairs.ts";
import type { BogieDetector, DetectedBogie, RunningGearPartition } from "./bogie-detector.ts";
import { clearance, type ClearanceWheelset } from "./clearance.ts";
import type { PartExtents } from "./part-extents.ts";
import type { PartRollingTable } from "./part-rolling.ts";
import { NO_VEHICLE, ON_BODY, restingCredits, type Riders } from "./resting-ride.ts";
import { AxleHeights } from "./support-plane.ts";
import type { DetectedWheelset, WheelsetDetector } from "./wheelset-detector.ts";

const SIXTEENTHS_PER_LDU = 16;
const ROW = 4;
const TRANSLATION = 3;
const POINT_FLOATS = 3;
const QUARTER_TURN = Math.PI / 2;

export interface ExposedConnectors {
  readonly count: number;
  readonly instance: Uint32Array;
  readonly connector: Uint32Array;
  readonly axis: Int8Array;
  readonly origin: Int32Array;
  readonly reach: Float32Array;
}

export interface RunningGearInput {
  readonly instances: PartInstances;
  readonly rolling: ReadonlyArray<PartRollingTable | null>;
  readonly extents: ReadonlyArray<PartExtents | null>;
  readonly connectors: ReadonlyArray<ConnectorTable | null>;
  readonly mates: MatePairs;
  readonly exposed: ExposedConnectors;
}

export interface RunningGear {
  readonly vehicles: ReadonlyArray<ModelVehicle>;
  readonly vehicleCouplings: ReadonlyArray<VehicleCoupling>;
  readonly unresolvedRunningGear: ReadonlyArray<UnresolvedRunningGear>;
  readonly unreadRollingBands: UnreadRollingBands;
}

interface Guide {
  readonly kind: VehicleGuide["kind"];
  readonly position: number;
  readonly bogie: number | null;
  readonly wheelset: number | null;
}

interface BodyGear {
  readonly body: number;
  readonly bogies: ReadonlyArray<DetectedBogie>;
  readonly fixedAxles: ReadonlyArray<number>;
  readonly travel: number;
  readonly guides: ReadonlyArray<Guide>;
}

interface EndCandidates {
  readonly front: ConnectorRef[];
  readonly rear: ConnectorRef[];
}

interface Link {
  readonly bodies: ReadonlyArray<number>;
  readonly attachments: ReadonlyArray<number>;
  readonly mates: ReadonlyArray<number>;
}

function midpoint(axisLine: Float64Array, dimension: number): number {
  return ((axisLine[dimension] ?? 0) + (axisLine[POINT_FLOATS + dimension] ?? 0)) / 2;
}

interface TippedCandidate {
  readonly ref: ConnectorRef;
  readonly tip: number;
}

function byTip(list: ReadonlyArray<TippedCandidate>): ConnectorRef[] {
  return list
    .toSorted(
      (a, b) =>
        b.tip - a.tip || a.ref.instance - b.ref.instance || a.ref.connector - b.ref.connector,
    )
    .map((candidate) => candidate.ref);
}

function bogieInstances(bogie: DetectedBogie, partition: RunningGearPartition): number[] {
  return [bogie.subAssembly, ...bogie.pendants]
    .flatMap((s) => [...(partition.subAssemblies[s]?.instances ?? [])])
    .toSorted((a, b) => a - b);
}

function travelOf(wheelset: DetectedWheelset): number {
  return wheelset.modelDimension === 0 ? 2 : 0;
}

export class RunningGearDetector {
  private readonly transform = new Float64Array(TRANSFORM_FLOATS);

  constructor(
    private readonly wheelsetDetector: WheelsetDetector,
    private readonly bogieDetector: BogieDetector,
  ) {}

  detect(input: RunningGearInput): RunningGear {
    const { instances, rolling, extents, connectors, mates, exposed } = input;
    const detection = this.wheelsetDetector.detect(instances, rolling);
    const wheelsets = detection.wheelsets;
    const partition = this.bogieDetector.partition(instances, connectors, mates, wheelsets);
    const frames = new SubmodelFrames(instances);
    const unread = detection.unreadRollingBands;
    const unreadRowsOf = (held: ReadonlySet<number>): number[] => {
      const rows: number[] = [];
      for (let row = 0; row < unread.instance.length; row++) {
        if (held.has(unread.instance[row] ?? -1)) rows.push(row);
      }
      return rows;
    };
    const unreadRows = (subAssemblies: ReadonlyArray<number>): number[] =>
      unreadRowsOf(
        new Set(subAssemblies.flatMap((s) => [...(partition.subAssemblies[s]?.instances ?? [])])),
      );
    const jointsOf = (rows: ReadonlyArray<number>): number[] =>
      this.bogieDetector.joints(frames, instances, connectors, mates, rows);
    const mateOf = (m: number): ConnectorMate => ({
      male: {
        instance: mates.maleInstance[m] ?? 0,
        connector: mates.maleConnector[m] ?? 0,
      },
      female: {
        instance: mates.femaleInstance[m] ?? 0,
        connector: mates.femaleConnector[m] ?? 0,
      },
    });
    const report = (
      reason: UnresolvedRunningGearReason,
      subAssemblies: ReadonlyArray<number>,
      wheelsetIndices: ReadonlyArray<number>,
      mateIndices: ReadonlyArray<number>,
    ): UnresolvedRunningGear => ({
      reason,
      instances: subAssemblies
        .flatMap((s) => [...(partition.subAssemblies[s]?.instances ?? [])])
        .toSorted((a, b) => a - b),
      wheelsets: wheelsetIndices.flatMap((w) => {
        const wheelset = wheelsets[w];
        return wheelset ? [this.wheelsetRecord(wheelset, partition.seated[w] === 1)] : [];
      }),
      mates: jointsOf(mateIndices).map(mateOf),
      unreadRows: unreadRows(subAssemblies),
    });
    const unresolved: UnresolvedRunningGear[] = [];
    for (const w of partition.spanningWheelsets) {
      const wheelset = wheelsets[w];
      if (!wheelset) continue;
      const held = [
        ...new Set(Array.from(wheelset.memberInstances, (i) => partition.subAssemblyOf[i] ?? 0)),
      ];
      const between = partition.edges.filter(
        (edge) => held.includes(edge.a) && held.includes(edge.b),
      );
      unresolved.push(
        report(
          "wheelsetSpansPivot",
          held,
          [w],
          between.flatMap((edge) => edge.mates),
        ),
      );
    }
    const excluded = new Set<number>();
    for (const bogie of partition.bogies) {
      if (bogie.carried.length <= 1) continue;
      unresolved.push(
        report(
          "sharedBogie",
          [bogie.subAssembly, ...bogie.carried],
          partition.subAssemblies[bogie.subAssembly]?.wheelsets ?? [],
          bogie.pivotMates,
        ),
      );
      for (const body of bogie.carried) excluded.add(body);
    }
    for (const { body, wheelsets: pair } of partition.unidentifiedSupportPlanes) {
      if (excluded.has(body)) continue;
      const under = partition.bogies
        .filter((bogie) => bogie.carried.includes(body))
        .map((bogie) => bogie.subAssembly);
      unresolved.push(report("supportPlaneUnidentified", [body, ...under], pair, []));
      excluded.add(body);
    }
    const gears = partition.bodies
      .filter((body) => !excluded.has(body))
      .map((body) =>
        this.bodyGear(body, partition, wheelsets, frames, instances, connectors, mates),
      );
    const spanned = new Map(
      gears.filter((gear) => gear.guides.length >= 2).map((gear) => [gear.body, gear]),
    );
    const couplingLinks: Link[] = [];
    for (const link of this.links(partition, new Set(gears.map((gear) => gear.body)))) {
      const inside = link.bodies.some((body) => {
        const gear = spanned.get(body);
        return (
          gear !== undefined &&
          !this.pivotsOutsideSpan(gear, link, partition, frames, instances, connectors, mates)
        );
      });
      if (inside) {
        unresolved.push(
          report("pivotInsideSupportSpan", [...link.bodies, ...link.attachments], [], link.mates),
        );
        for (const body of link.bodies) excluded.add(body);
      } else {
        couplingLinks.push(link);
      }
    }
    const attachedTo = this.soleNeighbours(partition);
    for (const gear of gears) {
      if (excluded.has(gear.body) || spanned.has(gear.body)) continue;
      unresolved.push(
        report(
          "fewerThanTwoGuides",
          [
            ...this.bodySubAssemblies(gear, attachedTo),
            ...gear.bogies.map((bogie) => bogie.subAssembly),
          ],
          [
            ...gear.fixedAxles,
            ...gear.bogies.flatMap((b) => partition.subAssemblies[b.subAssembly]?.wheelsets ?? []),
          ],
          gear.bogies.flatMap((bogie) => bogie.pivotMates),
        ),
      );
      excluded.add(gear.body);
    }
    const candidates = gears.filter((gear) => !excluded.has(gear.body));
    const riders = this.riders(candidates, partition, attachedTo, instances.count);
    for (const credit of restingCredits(frames, instances, extents, mates, riders)) {
      for (const instance of credit.instances) {
        riders.vehicleOf[instance] = credit.vehicle;
        riders.bogieOf[instance] = credit.bogie;
      }
    }
    const ridingOf = candidates.map((): number[] => []);
    riders.vehicleOf.forEach((v, instance) => {
      if (v !== NO_VEHICLE) ridingOf[v]?.push(instance);
    });
    const heights = new AxleHeights(frames);
    candidates.forEach((gear, v) => {
      const own = this.ownWheelsets(gear, partition);
      const seated = own.filter((w) => partition.seated[w] === 1);
      const members = new Set(seated.flatMap((w) => [...(wheelsets[w]?.memberInstances ?? [])]));
      const riding = ridingOf[v] ?? [];
      const failure = clearance(
        frames,
        heights,
        instances,
        extents,
        seated.flatMap((w) => this.clearanceWheelset(wheelsets[w])),
        riding.filter((instance) => !members.has(instance)),
      );
      if (!failure) return;
      unresolved.push({
        reason: failure.reason,
        instances: failure.instances.toSorted((a, b) => a - b),
        wheelsets: own.flatMap((w) => {
          const wheelset = wheelsets[w];
          return wheelset ? [this.wheelsetRecord(wheelset, partition.seated[w] === 1)] : [];
        }),
        mates: [],
        unreadRows: unreadRowsOf(new Set(riding)),
      });
      excluded.add(gear.body);
    });
    const kept = candidates.flatMap((gear, v) => (excluded.has(gear.body) ? [] : [{ gear, v }]));
    const resolved = kept.map(({ gear }) => gear);
    const vehicleOf = new Map(resolved.map((gear, index) => [gear.body, index]));
    const vehicleOfInstance = new Int32Array(instances.count).fill(NO_VEHICLE);
    kept.forEach(({ v }, index) => {
      for (const instance of ridingOf[v] ?? []) vehicleOfInstance[instance] = index;
    });
    const ends = this.endCandidates(exposed, resolved, vehicleOfInstance);
    const vehicles = kept.map(({ gear, v }, index) => {
      const riding = ridingOf[v] ?? [];
      return this.vehicleRecord(
        gear,
        partition,
        wheelsets,
        riding.filter((instance) => riders.bogieOf[instance] === ON_BODY),
        gear.bogies.map((_, b) => riding.filter((instance) => riders.bogieOf[instance] === b)),
        ends[index] ?? { front: [], rear: [] },
        frames,
        instances,
        connectors,
        mates,
      );
    });
    const vehicleCouplings: VehicleCoupling[] = couplingLinks.flatMap((link) => {
      const [a, b] = link.bodies.map((body) => vehicleOf.get(body));
      if (a === undefined || b === undefined || link.bodies.length !== 2) return [];
      const shared = this.bogieDetector.sharePivotLine(
        frames,
        instances,
        connectors,
        mates,
        link.mates,
      );
      const pivot = (row: number): number =>
        this.pivotPosition(link.mates[0] ?? 0, row, frames, instances, connectors, mates);
      return [
        {
          vehicles: [Math.min(a, b), Math.max(a, b)],
          mates: jointsOf(link.mates).map(mateOf),
          pivot: shared ? [pivot(0), pivot(1), pivot(2)] : null,
        },
      ];
    });
    return {
      vehicles,
      vehicleCouplings,
      unresolvedRunningGear: unresolved,
      unreadRollingBands: unread,
    };
  }

  private connectorPoint(
    frames: SubmodelFrames,
    instances: PartInstances,
    connectors: ReadonlyArray<ConnectorTable | null>,
    instance: number,
    connector: number,
    row: number,
  ): number {
    const part = connectors[instances.partIndex[instance] ?? -1];
    if (!part) return 0;
    frames.relate(instance, MODEL_ROOT, this.transform);
    const r = row * ROW;
    return (
      (this.transform[r] ?? 0) * connectorOriginLdu(part, connector, 0) +
      (this.transform[r + 1] ?? 0) * connectorOriginLdu(part, connector, 1) +
      (this.transform[r + 2] ?? 0) * connectorOriginLdu(part, connector, 2) +
      (this.transform[r + TRANSLATION] ?? 0)
    );
  }

  private pivotPosition(
    mate: number,
    row: number,
    frames: SubmodelFrames,
    instances: PartInstances,
    connectors: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
  ): number {
    return this.connectorPoint(
      frames,
      instances,
      connectors,
      mates.maleInstance[mate] ?? 0,
      mates.maleConnector[mate] ?? 0,
      row,
    );
  }

  private bodyGear(
    body: number,
    partition: RunningGearPartition,
    wheelsets: ReadonlyArray<DetectedWheelset>,
    frames: SubmodelFrames,
    instances: PartInstances,
    connectors: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
  ): BodyGear {
    const bogies = partition.bogies.filter(
      (bogie) => bogie.carried.length === 1 && bogie.carried[0] === body,
    );
    const fixedAxles = partition.subAssemblies[body]?.wheelsets ?? [];
    const firstWheelset =
      wheelsets[
        fixedAxles[0] ?? partition.subAssemblies[bogies[0]?.subAssembly ?? -1]?.wheelsets[0] ?? -1
      ];
    const travel = firstWheelset ? travelOf(firstWheelset) : 0;
    const guides: Guide[] = [
      ...bogies.map((bogie, index) => ({
        kind: "bogiePivot" as const,
        position: this.pivotPosition(
          bogie.pivotMates[0] ?? 0,
          travel,
          frames,
          instances,
          connectors,
          mates,
        ),
        bogie: index,
        wheelset: null,
      })),
      ...fixedAxles.map((w) => ({
        kind: "fixedAxle" as const,
        position: wheelsets[w]?.axisLine[travel] ?? 0,
        bogie: null,
        wheelset: w,
      })),
    ].toSorted((a, b) => b.position - a.position);
    return { body, bogies, fixedAxles, travel, guides };
  }

  private links(partition: RunningGearPartition, bodies: ReadonlySet<number>): Link[] {
    const attachments = new Set(partition.attachments);
    const direct: Link[] = [];
    const viaAttachment = new Map<number, { bodies: Set<number>; mates: number[] }>();
    for (const edge of partition.edges) {
      if (bodies.has(edge.a) && bodies.has(edge.b)) {
        direct.push({ bodies: [edge.a, edge.b], attachments: [], mates: edge.mates });
        continue;
      }
      const attachment = attachments.has(edge.a) ? edge.a : attachments.has(edge.b) ? edge.b : -1;
      const body = attachment === edge.a ? edge.b : edge.a;
      if (attachment < 0 || !bodies.has(body)) continue;
      const entry = viaAttachment.get(attachment) ?? { bodies: new Set<number>(), mates: [] };
      entry.bodies.add(body);
      entry.mates.push(...edge.mates);
      viaAttachment.set(attachment, entry);
    }
    const through: Link[] = [];
    for (const [attachment, entry] of viaAttachment) {
      if (entry.bodies.size < 2) continue;
      through.push({ bodies: [...entry.bodies], attachments: [attachment], mates: entry.mates });
    }
    return [...direct, ...through];
  }

  private pivotsOutsideSpan(
    gear: BodyGear,
    link: Link,
    partition: RunningGearPartition,
    frames: SubmodelFrames,
    instances: PartInstances,
    connectors: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
  ): boolean {
    const front = gear.guides[0]?.position ?? 0;
    const rear = gear.guides.at(-1)?.position ?? 0;
    const onBody = link.mates.filter((m) => {
      const male = partition.subAssemblyOf[mates.maleInstance[m] ?? 0];
      const female = partition.subAssemblyOf[mates.femaleInstance[m] ?? 0];
      return male === gear.body || female === gear.body;
    });
    return onBody.every((m) => {
      const position = this.pivotPosition(m, gear.travel, frames, instances, connectors, mates);
      return position > front || position < rear;
    });
  }

  private ownWheelsets(gear: BodyGear, partition: RunningGearPartition): number[] {
    return [
      ...gear.bogies.flatMap(
        (bogie) => partition.subAssemblies[bogie.subAssembly]?.wheelsets ?? [],
      ),
      ...gear.fixedAxles,
    ];
  }

  private clearanceWheelset(wheelset: DetectedWheelset | undefined): ClearanceWheelset[] {
    const headBands = wheelset ? this.wheelsetDetector.headBands(wheelset.rail) : null;
    return wheelset && headBands ? [{ wheelset, headBands }] : [];
  }

  private wheelsetRecord(wheelset: DetectedWheelset, seated: boolean): VehicleWheelset {
    const line = wheelset.axisLine;
    return {
      members: Array.from(wheelset.memberInstances, (instance, n) => ({
        instance,
        surface: wheelset.memberSurfaces[n] ?? 0,
      })),
      rail: wheelset.rail,
      frame: wheelset.frame,
      dimension: wheelset.dimension === 0 ? 0 : wheelset.dimension === 1 ? 1 : 2,
      trackCentre: wheelset.trackCentre,
      contactRadii: [
        formatExactRational(wheelset.contactRadii[0]),
        formatExactRational(wheelset.contactRadii[1]),
      ],
      rollingRadius: formatExactRational(wheelset.rollingRadius),
      rollingRadiusOnRail: wheelset.rollingRadiusOnRail.map((radius) =>
        radius ? formatExactRational(radius) : null,
      ),
      seated,
      axisLine: [
        [line[0] ?? 0, line[1] ?? 0, line[2] ?? 0],
        [line[3] ?? 0, line[4] ?? 0, line[5] ?? 0],
      ],
    };
  }

  private vehicleRecord(
    gear: BodyGear,
    partition: RunningGearPartition,
    wheelsets: ReadonlyArray<DetectedWheelset>,
    bodyInstances: ReadonlyArray<number>,
    bogieMembers: ReadonlyArray<ReadonlyArray<number>>,
    ends: EndCandidates,
    frames: SubmodelFrames,
    instances: PartInstances,
    connectors: ReadonlyArray<ConnectorTable | null>,
    mates: MatePairs,
  ): ModelVehicle {
    const lateral = gear.travel === 0 ? 2 : 0;
    const bogieWheelsets = gear.bogies.map(
      (bogie) => partition.subAssemblies[bogie.subAssembly]?.wheelsets ?? [],
    );
    const own = this.ownWheelsets(gear, partition);
    const local = new Map(own.map((w, index) => [w, index]));
    const front = gear.guides[0];
    const rear = gear.guides.at(-1);
    const originTravel = ((front?.position ?? 0) + (rear?.position ?? 0)) / 2;
    const originLateral =
      own.reduce(
        (sum, w) => sum + midpoint(wheelsets[w]?.axisLine ?? new Float64Array(6), lateral),
        0,
      ) / Math.max(own.length, 1);
    const origin: [number, number] =
      gear.travel === 0 ? [originTravel, originLateral] : [originLateral, originTravel];
    const guide = (g: Guide | undefined): VehicleGuide => ({
      kind: g?.kind ?? "fixedAxle",
      position: (g?.position ?? 0) - originTravel,
      bogie: g?.bogie ?? null,
      wheelset:
        g?.wheelset === null || g?.wheelset === undefined ? null : (local.get(g.wheelset) ?? null),
    });
    const bogies: VehicleBogie[] = gear.bogies.map((bogie, index) => ({
      instances: [...(bogieMembers[index] ?? [])],
      pivot: [0, 1, 2].map((row) =>
        this.pivotPosition(bogie.pivotMates[0] ?? 0, row, frames, instances, connectors, mates),
      ) as [number, number, number],
      wheelsets: (bogieWheelsets[index] ?? []).map((w) => local.get(w) ?? 0),
    }));
    return {
      origin,
      yaw: gear.travel === 0 ? 0 : QUARTER_TURN,
      guides: [guide(front), guide(rear)],
      body: [...bodyInstances],
      bogies,
      fixedAxles: gear.fixedAxles.map((w) => local.get(w) ?? 0),
      wheelsets: [
        ...own,
        ...wheelsets.flatMap((_, w) => (partition.unseatedBy[w] === gear.body ? [w] : [])),
      ].flatMap((w) => {
        const wheelset = wheelsets[w];
        return wheelset ? [this.wheelsetRecord(wheelset, partition.seated[w] === 1)] : [];
      }),
      frontEndCandidates: ends.front,
      rearEndCandidates: ends.rear,
    };
  }

  private soleNeighbours(partition: RunningGearPartition): Map<number, number> {
    const attachments = new Set(partition.attachments);
    const group = new Map<number, number>(partition.attachments.map((a) => [a, a]));
    const root = (a: number): number => {
      let current = a;
      for (
        let next = group.get(current);
        next !== undefined && next !== current;
        next = group.get(current)
      ) {
        current = next;
      }
      return current;
    };
    for (const edge of partition.edges) {
      if (attachments.has(edge.a) && attachments.has(edge.b)) group.set(root(edge.a), root(edge.b));
    }
    const neighbours = new Map<number, Set<number>>();
    for (const edge of partition.edges) {
      for (const [from, to] of [
        [edge.a, edge.b],
        [edge.b, edge.a],
      ] as const) {
        if (!attachments.has(from) || attachments.has(to)) continue;
        const set = neighbours.get(root(from)) ?? new Set<number>();
        set.add(to);
        neighbours.set(root(from), set);
      }
    }
    const sole = new Map<number, number>();
    for (const attachment of partition.attachments) {
      const set = neighbours.get(root(attachment));
      const [only] = set ?? [];
      if (set?.size === 1 && only !== undefined) sole.set(attachment, only);
    }
    return sole;
  }

  private bodySubAssemblies(gear: BodyGear, attachedTo: ReadonlyMap<number, number>): number[] {
    const subAssemblies = [gear.body];
    for (const [attachment, body] of attachedTo)
      if (body === gear.body) subAssemblies.push(attachment);
    return subAssemblies;
  }

  private bodyInstances(
    gear: BodyGear,
    partition: RunningGearPartition,
    attachedTo: ReadonlyMap<number, number>,
  ): number[] {
    return this.bodySubAssemblies(gear, attachedTo)
      .flatMap((s) => [...(partition.subAssemblies[s]?.instances ?? [])])
      .toSorted((a, b) => a - b);
  }

  private riders(
    gears: ReadonlyArray<BodyGear>,
    partition: RunningGearPartition,
    attachedTo: ReadonlyMap<number, number>,
    count: number,
  ): Riders {
    const vehicleOf = new Int32Array(count).fill(NO_VEHICLE);
    const bogieOf = new Int32Array(count).fill(ON_BODY);
    gears.forEach((gear, v) => {
      for (const instance of this.bodyInstances(gear, partition, attachedTo)) {
        vehicleOf[instance] = v;
      }
      gear.bogies.forEach((bogie, b) => {
        for (const instance of bogieInstances(bogie, partition)) {
          vehicleOf[instance] = v;
          bogieOf[instance] = b;
        }
      });
    });
    return { vehicleOf, bogieOf };
  }

  private endCandidates(
    exposed: ExposedConnectors,
    gears: ReadonlyArray<BodyGear>,
    vehicleOfInstance: Int32Array,
  ): EndCandidates[] {
    const found = gears.map(() => ({
      front: [] as TippedCandidate[],
      rear: [] as TippedCandidate[],
    }));
    for (let k = 0; k < exposed.count; k++) {
      const instance = exposed.instance[k] ?? 0;
      const v = vehicleOfInstance[instance] ?? -1;
      const gear = gears[v];
      const lists = found[v];
      if (!gear || !lists) continue;
      const axis = exposed.axis[k] ?? AXIS_FREE;
      if (axis === AXIS_FREE || axisDimension(axis) !== gear.travel) continue;
      const outward = axisSign(axis);
      const guide = outward > 0 ? gear.guides[0] : gear.guides.at(-1);
      const origin = (exposed.origin[k * VECTOR_FLOATS + gear.travel] ?? 0) / SIXTEENTHS_PER_LDU;
      if (outward * (origin - (guide?.position ?? 0)) <= 0) continue;
      const tip = outward * origin + (exposed.reach[k] ?? 0);
      (outward > 0 ? lists.front : lists.rear).push({
        ref: { instance, connector: exposed.connector[k] ?? 0 },
        tip,
      });
    }
    return found.map((lists) => ({ front: byTip(lists.front), rear: byTip(lists.rear) }));
  }
}
