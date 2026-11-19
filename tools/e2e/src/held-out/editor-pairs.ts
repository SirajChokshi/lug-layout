import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type {
  AssistNeighbourhood,
  ConnectorKindView,
  HoverMateCount,
  HoverRefusalHit,
  IEditor,
  PlacementHover,
  PlacementMode,
} from "@brr/client";
import type { Assembly, AssemblyPart } from "./assembly.ts";
import type { ModulePair } from "./generator.ts";
import { shiftedOutcomes } from "./pair-scenario.ts";
import type { AimedBackend } from "./headless-editor.ts";

const QUARTER_TURNS_AWAY = 2;
const QUARTER_TURNS = 4;
const MODEL_IDENTITY_KEYS = new Set(["item", "label"]);
const MODE_DEPENDENT_KEYS = new Set(["mode", "turnBlocksSnap", "turnMates"]);
const LISTED_FAILURES = 4;
const LOAD_POLL_MS = 10;
const LOAD_TIMEOUT_MS = 60_000;
const NO_TIME = 0;

export interface Pose {
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

type Vec3 = readonly [number, number, number];

export interface EditorCheck {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

interface Step {
  readonly aim: Pose;
  readonly cursor: Pose | null;
  readonly hover: PlacementHover | null;
  readonly hoverText: string | null;
  readonly committed: Pose | null;
  readonly refused: boolean;
  readonly refusal: string | null;
}

export interface ModelInput {
  readonly name: string;
  readonly text: string;
}

function describePose(pose: Pose | null | undefined): string {
  if (!pose) return "none";
  return `(${pose.x}, ${pose.z}) at ${pose.yPlates} plates, ${pose.rot} quarter turns`;
}

function samePose(a: Pose | null | undefined, b: Pose | null | undefined): boolean {
  return !!a && !!b && a.x === b.x && a.z === b.z && a.yPlates === b.yPlates && a.rot === b.rot;
}

function roundSections(kind: ConnectorKindView): boolean {
  return kind.sections.every(
    (section) => section.profile === "round" || section.profile === "flare",
  );
}

function counterboredAtBothMouths(kind: ConnectorKindView): boolean {
  const first = kind.sections[0];
  const last = kind.sections.at(-1);
  const inner = kind.sections.slice(1, -1);
  return (
    first !== undefined &&
    last !== undefined &&
    inner.length > 0 &&
    inner.every((section) => section.sizeLdu < first.sizeLdu && section.sizeLdu < last.sizeLdu)
  );
}

function isTechnicHole(kind: ConnectorKindView): boolean {
  return (
    kind.gender === "female" &&
    kind.slides &&
    kind.sections.every((section) => section.profile === "round") &&
    counterboredAtBothMouths(kind)
  );
}

function isTechnicPin(kind: ConnectorKindView): boolean {
  return (
    kind.gender === "male" &&
    roundSections(kind) &&
    kind.sections.some((section) => section.profile === "flare")
  );
}

function pinHoleMates(mates: ReadonlyArray<HoverMateCount>): ReadonlyArray<HoverMateCount> {
  return mates.filter(
    (mate) =>
      mate.partnerKinds.length > 0 &&
      ((isTechnicHole(mate.kind) && mate.partnerKinds.every(isTechnicPin)) ||
        (isTechnicPin(mate.kind) && mate.partnerKinds.every(isTechnicHole))),
  );
}

export function pinHoleJoints(mates: ReadonlyArray<HoverMateCount>): number {
  return pinHoleMates(mates).reduce((sum, mate) => sum + mate.joints, 0);
}

function describeMates(mates: ReadonlyArray<HoverMateCount>): string {
  if (mates.length === 0) return "no mates";
  return mates
    .map(
      (mate) =>
        `${mate.joints} joints (${mate.connectors} held ${mate.kind.gender} ${mate.kind.sections.map((s) => `${s.profile} ${s.sizeLdu}`).join("/")}${mate.kind.slides ? " sliding" : ""} against ${mate.partnerKinds.map((k) => `${k.gender} ${k.sections.map((s) => `${s.profile} ${s.sizeLdu}`).join("/")}`).join(", ")})`,
    )
    .join("; ");
}

function describeHover(hover: PlacementHover | null): string {
  if (!hover) return "no placement hover";
  const verdict = hover.accepted ? "accepted" : "refused";
  const hit = hover.hit
    ? `, hit ${hover.hit.partLabel ?? hover.hit.part ?? "a part"} of ${hover.hit.placed.label} in cell (${hover.hit.cellX}, ${hover.hit.cellZ})`
    : "";
  const magnet = hover.magnetised
    ? `, magnetised by (${hover.magnet.dxLdu}, ${hover.magnet.dzLdu}) LDU`
    : "";
  return `${hover.mode} ${verdict} at ${describePose(hover.pose)}${magnet}${hover.lifted ? ", lifted" : ""}${hit}; ${describeMates(hover.mates)}`;
}

export class EditorPath {
  constructor(
    private readonly editor: IEditor,
    private readonly backend: AimedBackend,
  ) {}

  async importModel(model: ModelInput): Promise<string> {
    const imported = await this.editor.importModelFile({
      name: model.name,
      bytes: new TextEncoder().encode(model.text),
    });
    const item = this.editor.snapshot().activeItem;
    if (!imported || item === null) {
      const view = this.editor.snapshot().modelImport;
      throw new Error(
        `${model.name} didn't become placeable: ${view?.reason ?? "no reason given"}`,
      );
    }
    return item;
  }

  frameShift(item: string): Vec3 {
    const dump = this.editor.dump();
    const index = dump.covers.findIndex(
      (cover) => item === cover.id || item.startsWith(`${cover.id}@`),
    );
    const shift = dump.frameShifts[index];
    if (index < 0 || !shift) throw new Error(`${item} has no loaded placeable`);
    return [shift[0], shift[1], shift[2]];
  }

  async hold(item: string, turns = 0): Promise<void> {
    this.editor.chooseItem(item);
    const deadline = performance.now() + LOAD_TIMEOUT_MS;
    while (
      this.editor.snapshot().activeItem !== item ||
      this.editor.snapshot().pendingItem !== null
    ) {
      if (performance.now() > deadline)
        throw new Error(`${item} didn't load within ${LOAD_TIMEOUT_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, LOAD_POLL_MS));
    }
    for (
      let press = 0;
      press < QUARTER_TURNS && this.editor.snapshot().ghostRot !== turns;
      press++
    ) {
      this.editor.rotate(NO_TIME);
    }
  }

  setMode(mode: PlacementMode): void {
    this.editor.setPlacementMode(mode);
  }

  hoverAt(
    x: number,
    z: number,
  ): {
    readonly hover: PlacementHover | null;
    readonly text: string | null;
    readonly cursor: Pose | null;
  } {
    this.backend.aim(x, z);
    this.editor.pointerMove(0, 0);
    const { hover, ghostRot } = this.editor.snapshot();
    return {
      hover: hover?.placement ?? null,
      text: hover?.refusal ?? null,
      cursor: hover ? { x: hover.x, z: hover.z, yPlates: hover.yPlates, rot: ghostRot } : null,
    };
  }

  step(x: number, z: number, commit: boolean): Step {
    const { hover, text, cursor } = this.hoverAt(x, z);
    const before = this.editor.snapshot();
    const aim: Pose = { x, z, yPlates: 0, rot: before.ghostRot };
    if (!commit)
      return {
        aim,
        cursor,
        hover,
        hoverText: text,
        committed: null,
        refused: false,
        refusal: null,
      };
    this.editor.click(0, 0, NO_TIME);
    const after = this.editor.snapshot();
    const refused = after.refusedClicks > before.refusedClicks;
    const committed = after.placements > before.placements ? this.lastPlacement() : null;
    return {
      aim,
      cursor,
      hover,
      hoverText: text,
      committed,
      refused,
      refusal: refused ? (after.lastRefusal?.reason ?? null) : null,
    };
  }

  undoLast(): void {
    this.editor.undo(NO_TIME);
  }

  lastPlacement(): Pose {
    const { placements } = this.editor.dump();
    const last = placements.x.length - 1;
    return {
      x: placements.x[last] ?? 0,
      z: placements.z[last] ?? 0,
      yPlates: placements.yPlates[last] ?? 0,
      rot: placements.rot[last] ?? 0,
    };
  }
}

export function fromLdrawFrame(vector: Vec3): Vec3 {
  return [vector[0], 0 - vector[1], 0 - vector[2]];
}

export interface Seam {
  readonly flush: Pose;
  readonly toward: Vec3;
  readonly along: Vec3;
}

export interface PairPoses extends Seam {
  readonly placed: Pose;
  readonly placedShift: Vec3;
  readonly heldShift: Vec3;
}

export function pairPoses(
  path: EditorPath,
  heldOffset: Vec3,
  alongEdge: Vec3,
  placedItem: string,
  placed: Pose,
  heldItem: string,
): PairPoses {
  const placedShift = path.frameShift(placedItem);
  const heldShift = path.frameShift(heldItem);
  const worldOffset = fromLdrawFrame(heldOffset);
  const flush: Pose = {
    x: placed.x + placedShift[0] + worldOffset[0] - heldShift[0],
    z: placed.z + placedShift[2] + worldOffset[2] - heldShift[2],
    yPlates: placed.yPlates,
    rot: placed.rot,
  };
  const toward: Vec3 = [
    -Math.sign(worldOffset[0]) * STUD_LDU,
    0,
    -Math.sign(worldOffset[2]) * STUD_LDU,
  ];
  return { placed, placedShift, heldShift, flush, toward, along: fromLdrawFrame(alongEdge) };
}

function offset(pose: Pose, by: Vec3, studs: number): Pose {
  return { ...pose, x: pose.x + by[0] * studs, z: pose.z + by[2] * studs };
}

export interface PairRun {
  readonly placedLabel: string;
  readonly checks: ReadonlyArray<EditorCheck>;
  readonly steps: ReadonlyArray<{ readonly label: string; readonly step: Step }>;
}

function stem(reference: string): string {
  return reference.replace(/\.dat$/iu, "").toLowerCase();
}

function namesPart(part: string | null, parts: Assembly): boolean {
  if (part === null) return false;
  const named = part.toLowerCase();
  return parts.some(
    (candidate) =>
      named === stem(candidate.reference) || named.endsWith(`:${stem(candidate.reference)}`),
  );
}

export interface PosedAssembly {
  readonly parts: Assembly;
  readonly origin: Vec3;
}

export function posed(parts: Assembly, pose: Pose, shift: Vec3): PosedAssembly {
  if (pose.rot !== 0) throw new Error("the harness poses assemblies unturned only");
  return {
    parts,
    origin: [pose.x + shift[0], pose.yPlates * PLATE_LDU + shift[1], pose.z + shift[2]],
  };
}

export function pinsOf(parts: Assembly): Assembly {
  return parts.filter((part) => part.pin !== null);
}

interface HitBox {
  readonly cellX: number;
  readonly cellZ: number;
  readonly bottomLdu: number;
  readonly topLdu: number;
}

function coversCell(part: AssemblyPart, origin: Vec3, box: HitBox): boolean {
  const x0 = box.cellX * STUD_LDU;
  const z0 = box.cellZ * STUD_LDU;
  return (
    origin[0] + part.min[0] < x0 + STUD_LDU &&
    origin[0] + part.max[0] > x0 &&
    origin[2] - part.max[2] < z0 + STUD_LDU &&
    origin[2] - part.min[2] > z0
  );
}

function overlapsHit(part: AssemblyPart, origin: Vec3, box: HitBox): boolean {
  return (
    coversCell(part, origin, box) &&
    origin[1] - part.max[1] < box.topLdu &&
    origin[1] - part.min[1] > box.bottomLdu
  );
}

function columnOverlapsHit(posedParts: PosedAssembly, box: HitBox): boolean {
  const inCell = posedParts.parts.filter((part) => coversCell(part, posedParts.origin, box));
  const bottom = Math.min(...inCell.map((part) => posedParts.origin[1] - part.max[1]));
  const top = Math.max(...inCell.map((part) => posedParts.origin[1] - part.min[1]));
  return inCell.length > 0 && bottom < box.topLdu && top > box.bottomLdu;
}

export function hitIsReal(
  hit: HoverRefusalHit | null,
  placedItem: string,
  named: PosedAssembly,
  held: PosedAssembly,
): boolean {
  if (hit === null || hit.placed.item !== placedItem || hit.part === null) return false;
  const box: HitBox = {
    cellX: hit.cellX,
    cellZ: hit.cellZ,
    bottomLdu: Math.max(hit.placedBottomLdu, hit.heldBottomLdu),
    topLdu: Math.min(hit.placedTopLdu, hit.heldTopLdu),
  };
  if (box.bottomLdu >= box.topLdu) return false;
  return (
    named.parts.some(
      (part) => namesPart(hit.part, [part]) && overlapsHit(part, named.origin, box),
    ) && columnOverlapsHit(held, box)
  );
}

export interface SweepOffset {
  readonly along: number;
  readonly across: number;
}

const AT_FLUSH: SweepOffset = { along: 0, across: 0 };
const ONE_STUD_SHORT: SweepOffset = { along: 0, across: -1 };
const ONE_STUD_IN: SweepOffset = { along: 0, across: 1 };
const ONE_STUD_ALONG: SweepOffset = { along: 1, across: 0 };
const ONE_STUD_BACK_ALONG: SweepOffset = { along: -1, across: 0 };
const NO_NEIGHBOURHOOD: AssistNeighbourhood = { ldu: 0, cells: 0, plates: 0 };

export function sweepOffsets(reachCells: number, full: boolean): ReadonlyArray<SweepOffset> {
  const outer = reachCells + 1;
  const offsets = new Map<string, SweepOffset>();
  const add = (along: number, across: number): void => {
    offsets.set(`${along},${across}`, { along: along + 0, across: across + 0 });
  };
  if (full) {
    for (let along = -outer; along <= outer; along++) {
      for (let across = -outer; across <= outer; across++) add(along, across);
    }
    return [...offsets.values()];
  }
  for (const reach of new Set([0, 1, reachCells, outer])) {
    for (const value of [reach, -reach]) {
      add(0, value);
      add(value, 0);
      add(value, value);
      add(value, -value);
    }
  }
  return [...offsets.values()];
}

function cursorAt(seam: Seam, at: SweepOffset): Pose {
  return offset(offset(seam.flush, seam.along, at.along), seam.toward, at.across);
}

function describeOffset(at: SweepOffset): string {
  const across =
    at.across === 0 ? "flush" : at.across > 0 ? `${at.across} in` : `${-at.across} short`;
  return at.along === 0 ? across : `${across}, ${at.along} along`;
}

function withinNeighbourhood(at: SweepOffset, neighbourhood: AssistNeighbourhood): boolean {
  return STUD_LDU * Math.sqrt(at.along * at.along + at.across * at.across) <= neighbourhood.ldu;
}

function magnetIsExact(hover: PlacementHover, cursor: Pose): boolean {
  const dx = hover.pose.x - cursor.x;
  const dz = hover.pose.z - cursor.z;
  const dy = hover.pose.yPlates - cursor.yPlates;
  const moved = dx !== 0 || dz !== 0 || dy !== 0 || hover.pose.rot !== cursor.rot;
  return (
    hover.magnetised === moved &&
    hover.magnet.dxLdu === dx &&
    hover.magnet.dzLdu === dz &&
    hover.magnet.dyPlates === dy &&
    hover.magnet.distanceLdu === Math.sqrt(dx * dx + dz * dz + (PLATE_LDU * dy) ** 2)
  );
}

function snapsFlush(step: Step, seam: Seam, pins: number): boolean {
  const { hover, cursor } = step;
  return (
    hover !== null &&
    cursor !== null &&
    samePose(cursor, step.aim) &&
    hover.mode === "assist" &&
    hover.accepted &&
    samePose(hover.pose, seam.flush) &&
    !hover.lifted &&
    pinHoleJoints(hover.mates) === pins &&
    magnetIsExact(hover, cursor)
  );
}

function atCursor(step: Step, mode: PlacementMode): boolean {
  const { hover, cursor } = step;
  return (
    hover !== null &&
    cursor !== null &&
    samePose(cursor, step.aim) &&
    hover.mode === mode &&
    samePose(hover.pose, cursor) &&
    magnetIsExact(hover, cursor)
  );
}

export function placementVerdict(hover: PlacementHover | null): string {
  return JSON.stringify(hover, (key, field: unknown) =>
    MODE_DEPENDENT_KEYS.has(key) ? undefined : field,
  );
}

function stepVerdict(step: Step): string {
  return `${JSON.stringify(step.cursor)} ${placementVerdict(step.hover)}`;
}

function sweepCheck<T>(
  label: string,
  items: ReadonlyArray<T>,
  passes: (item: T) => boolean,
  describe: (item: T) => string,
  passedDetail: string,
): EditorCheck {
  const failed = items.filter((item) => !passes(item));
  const listed = failed.slice(0, LISTED_FAILURES).map(describe).join("; ");
  const more = failed.length > LISTED_FAILURES ? `; ${failed.length - LISTED_FAILURES} more` : "";
  return {
    label,
    passed: items.length > 0 && failed.length === 0,
    detail:
      items.length === 0
        ? "no offsets to check"
        : failed.length === 0
          ? passedDetail
          : `${failed.length} of ${items.length} fail: ${listed}${more}`,
  };
}

interface Probe {
  readonly at: SweepOffset;
  readonly step: Step;
}

interface Compared {
  readonly at: SweepOffset;
  readonly assist: Step;
  readonly precise: Step;
}

class StepLog {
  readonly steps: Array<{ readonly label: string; readonly step: Step }> = [];

  constructor(
    private readonly path: EditorPath,
    private readonly heldItem: string,
    private readonly seam: Seam,
  ) {}

  async at(mode: PlacementMode, at: SweepOffset, commit: boolean, turns = 0): Promise<Step> {
    await this.path.hold(this.heldItem, turns);
    this.path.setMode(mode);
    const cursor = cursorAt(this.seam, at);
    const step = this.path.step(cursor.x, cursor.z, commit);
    if (step.committed) this.path.undoLast();
    const turned = turns === 0 ? "" : `, turned ${turns} quarter turns`;
    this.steps.push({
      label: `${mode} ${describeOffset(at)}${turned}${commit ? ", clicked" : ""}`,
      step,
    });
    return step;
  }
}

function outcome(step: Step): string {
  const clicked = step.refused
    ? `; refused: ${step.refusal ?? "no reason"}`
    : step.committed
      ? `; committed ${describePose(step.committed)}`
      : "";
  return `cursor ${describePose(step.cursor)}; hover ${describeHover(step.hover)}${clicked}`;
}

export async function pinnedPairChecks(
  path: EditorPath,
  poses: PairPoses,
  pair: ModulePair,
  placedItem: string,
  heldItem: string,
  full: boolean,
): Promise<PairRun> {
  const { pins } = pair;
  const log = new StepLog(path, heldItem, poses);
  const probe = await log.at("assist", AT_FLUSH, false);
  const neighbourhood = probe.hover?.assistNeighbourhood ?? NO_NEIGHBOURHOOD;
  const inside: Probe[] = [];
  const beyond: Compared[] = [];
  for (const at of sweepOffsets(neighbourhood.cells, full)) {
    const assist = await log.at("assist", at, false);
    if (withinNeighbourhood(at, neighbourhood)) inside.push({ at, step: assist });
    else beyond.push({ at, assist, precise: await log.at("precise", at, false) });
  }
  const assistShort = await log.at("assist", ONE_STUD_SHORT, true);
  const assistIn = await log.at("assist", ONE_STUD_IN, true);
  const preciseFlush = await log.at("precise", AT_FLUSH, true);
  const preciseShort = await log.at("precise", ONE_STUD_SHORT, true);
  const preciseIn = await log.at("precise", ONE_STUD_IN, true);
  const alongForward = await log.at("precise", ONE_STUD_ALONG, true);
  const alongBack = await log.at("precise", ONE_STUD_BACK_ALONG, true);
  path.setMode("assist");
  const named = posed(pair.subject.assembly, poses.placed, poses.placedShift);
  const realHit = (step: Step): boolean =>
    step.hover !== null &&
    step.hover.accepted === false &&
    hitIsReal(
      step.hover.hit,
      placedItem,
      named,
      posed(pair.partner.assembly, step.hover.pose, poses.heldShift),
    );
  const committedFlush = (step: Step): boolean => samePose(step.committed, poses.flush);
  const shiftedAllowed = (step: Step, sign: number): boolean => {
    if (!atCursor(step, "precise")) return false;
    if (shiftedOutcomes(pair, sign).some((shifted) => shifted.kind === "colliding")) {
      return realHit(step) && step.committed === null;
    }
    return step.hover !== null && pinHoleJoints(step.hover.mates) < pins;
  };
  const refusedBeyond = beyond.filter(({ precise }) => precise.hover?.accepted === false).length;
  const checks: EditorCheck[] = [
    {
      label:
        "Assist reaches at least one stud: from one stud short and from one stud in it snaps flush with every pin engaged, and the click commits flush",
      passed:
        snapsFlush(assistShort, poses, pins) &&
        committedFlush(assistShort) &&
        snapsFlush(assistIn, poses, pins) &&
        committedFlush(assistIn),
      detail: `expected ${describePose(poses.flush)} with ${pins} pin/hole joints; one stud short: ${outcome(assistShort)}; one stud in: ${outcome(assistIn)}`,
    },
    sweepCheck(
      `Assist sweep: every cursor offset within the reported neighbourhood (${neighbourhood.ldu} LDU) snaps flush with every pin engaged, magnetised by exactly the offset`,
      inside,
      ({ step }) => snapsFlush(step, poses, pins),
      ({ at, step }) => `${describeOffset(at)}: ${outcome(step)}`,
      `${inside.length} offsets, all flush with ${pins} pin/hole joints`,
    ),
    sweepCheck(
      "Assist sweep: beyond the neighbourhood, assist gives exactly the precise result at the same cursor pose (pose, verdict, hit and mates; the turn hint is assist's own), and every refusal names a part and cell where the two models overlap",
      beyond,
      ({ assist, precise }) =>
        stepVerdict(assist) === stepVerdict(precise) &&
        atCursor(precise, "precise") &&
        (precise.hover?.accepted === true || realHit(precise)),
      ({ at, assist, precise }) =>
        `${describeOffset(at)}: assist ${outcome(assist)}; precise ${outcome(precise)}`,
      `${beyond.length} offsets: ${refusedBeyond} refused with a real hit, ${beyond.length - refusedBeyond} accepted at the cursor pose, assist identical to precise at each`,
    ),
    {
      label: "Both modes report the same assist neighbourhood",
      passed:
        probe.hover !== null &&
        preciseFlush.hover !== null &&
        JSON.stringify(probe.hover.assistNeighbourhood) ===
          JSON.stringify(preciseFlush.hover.assistNeighbourhood),
      detail: `assist ${JSON.stringify(probe.hover?.assistNeighbourhood ?? null)}; precise ${JSON.stringify(preciseFlush.hover?.assistNeighbourhood ?? null)}`,
    },
    {
      label: "Precise: flush is accepted with every pin mated, and the click commits it",
      passed:
        atCursor(preciseFlush, "precise") &&
        preciseFlush.hover?.accepted === true &&
        pinHoleJoints(preciseFlush.hover.mates) === pins &&
        committedFlush(preciseFlush),
      detail: `expected ${pins} pin/hole joints; ${outcome(preciseFlush)}`,
    },
    {
      label:
        "Precise: one stud short is accepted at the cursor pose with a gap and no mates, and the click commits it there",
      passed:
        atCursor(preciseShort, "precise") &&
        preciseShort.hover?.accepted === true &&
        preciseShort.hover.mates.length === 0 &&
        samePose(preciseShort.committed, preciseShort.cursor),
      detail: outcome(preciseShort),
    },
    {
      label:
        "Precise: one stud in is refused, naming the part and cell it hits, and the click places nothing",
      passed:
        atCursor(preciseIn, "precise") &&
        realHit(preciseIn) &&
        preciseIn.refused &&
        preciseIn.committed === null,
      detail: outcome(preciseIn),
    },
    {
      label:
        "Precise: one stud along the edge either way, at least one pin collides or misses (#441): a colliding pose is refused, and a missing one never has every pin engaged",
      passed: shiftedAllowed(alongForward, 1) && shiftedAllowed(alongBack, -1),
      detail: `forward: ${outcome(alongForward)}; back: ${outcome(alongBack)}`,
    },
  ];
  return { placedLabel: "pinned", checks, steps: log.steps };
}

export async function holesAgainstHolesCheck(
  path: EditorPath,
  poses: PairPoses,
  heldItem: string,
): Promise<EditorCheck> {
  const step = await new StepLog(path, heldItem, poses).at("assist", AT_FLUSH, true);
  return {
    label: "Holes against holes place flush",
    passed:
      step.hover?.accepted === true &&
      !step.hover.lifted &&
      step.hover.hit === null &&
      pinHoleJoints(step.hover.mates) === 0 &&
      samePose(step.committed, poses.flush),
    detail: `expected ${describePose(poses.flush)} with no pin/hole joint; ${outcome(step)}`,
  };
}

export async function turnedAwayCheck(
  path: EditorPath,
  poses: PairPoses,
  heldItem: string,
  pins: number,
): Promise<EditorCheck> {
  const log = new StepLog(path, heldItem, poses);
  const step = await log.at("assist", ONE_STUD_SHORT, false, QUARTER_TURNS_AWAY);
  await path.hold(heldItem, 0);
  return {
    label:
      "Turned 180° so the holes face away, assist doesn't snap: no pin/hole mates and the cursor pose is kept, while turnBlocksSnap and turnMates say a turn would engage every pin",
    passed:
      step.hover !== null &&
      atCursor(step, "assist") &&
      pinHoleJoints(step.hover.mates) === 0 &&
      step.hover.turnBlocksSnap &&
      pinHoleJoints(step.hover.turnMates) === pins,
    detail: `held turned ${QUARTER_TURNS_AWAY} quarter turns, aimed one stud short; ${outcome(step)}${step.hover?.turnBlocksSnap ? `; a turn would snap: ${describeMates(step.hover.turnMates)}` : ""}`,
  };
}

function withoutModelIdentity(value: unknown): string {
  return JSON.stringify(value, (key, field: unknown) =>
    MODEL_IDENTITY_KEYS.has(key) ? undefined : field,
  );
}

export function sameOutcomes(a: PairRun, b: PairRun): ReadonlyArray<string> {
  const differences: string[] = [];
  a.steps.forEach(({ label, step }, index) => {
    const other = b.steps[index]?.step;
    if (!other) {
      differences.push(`${label}: missing`);
      return;
    }
    const left = withoutModelIdentity({
      hover: step.hover,
      committed: step.committed,
      refused: step.refused,
    });
    const right = withoutModelIdentity({
      hover: other.hover,
      committed: other.committed,
      refused: other.refused,
    });
    if (left !== right) differences.push(label);
  });
  if (a.steps.length !== b.steps.length) {
    differences.push(`${a.steps.length} steps against ${b.steps.length}`);
  }
  return differences;
}

export async function cornerModuleCheck(
  path: EditorPath,
  templateItem: string,
  templatePose: Pose,
  moduleItem: string,
  offsetFromTemplate: Vec3,
  pins: number,
  full: boolean,
): Promise<EditorCheck> {
  const templateShift = path.frameShift(templateItem);
  const moduleShift = path.frameShift(moduleItem);
  const worldOffset = fromLdrawFrame(offsetFromTemplate);
  const toward: Vec3 = [
    -Math.sign(worldOffset[0]) * STUD_LDU,
    0,
    -Math.sign(worldOffset[2]) * STUD_LDU,
  ];
  const seam: Seam = {
    flush: {
      x: templatePose.x + templateShift[0] + worldOffset[0] - moduleShift[0],
      z: templatePose.z + templateShift[2] + worldOffset[2] - moduleShift[2],
      yPlates: templatePose.yPlates,
      rot: templatePose.rot,
    },
    toward,
    along: [toward[2] === 0 ? 0 : STUD_LDU, 0, toward[0] === 0 ? 0 : STUD_LDU],
  };
  const log = new StepLog(path, moduleItem, seam);
  const probe = await log.at("assist", AT_FLUSH, false);
  const neighbourhood = probe.hover?.assistNeighbourhood ?? NO_NEIGHBOURHOOD;
  const inside: Probe[] = [];
  for (const at of sweepOffsets(neighbourhood.cells, full)) {
    if (withinNeighbourhood(at, neighbourhood)) {
      inside.push({ at, step: await log.at("assist", at, false) });
    }
  }
  const clicked = await log.at("assist", ONE_STUD_SHORT, true);
  const sweep = sweepCheck(
    "",
    inside,
    ({ step }) => snapsFlush(step, seam, pins),
    ({ at, step }) => `${describeOffset(at)}: ${outcome(step)}`,
    `${inside.length} offsets within ${neighbourhood.ldu} LDU, all flush with ${pins} pin/hole joints`,
  );
  const clickedFlush = snapsFlush(clicked, seam, pins) && samePose(clicked.committed, seam.flush);
  return {
    label:
      "A generated module with corner Technic joins mates an official template: in assist, every offset within the neighbourhood snaps flush with every pin engaged, and a click from one stud short commits flush",
    passed: sweep.passed && clickedFlush,
    detail: `${sweep.detail}; one stud short, clicked: ${outcome(clicked)}`,
  };
}

export async function solidEdgeChecks(
  path: EditorPath,
  poses: PairPoses,
  solidParts: Assembly,
  heldParts: Assembly,
  placedItem: string,
  heldItem: string,
  full: boolean,
): Promise<PairRun> {
  const log = new StepLog(path, heldItem, poses);
  const probe = await log.at("assist", AT_FLUSH, false);
  const neighbourhood = probe.hover?.assistNeighbourhood ?? NO_NEIGHBOURHOOD;
  const compared: Compared[] = [];
  for (const at of sweepOffsets(neighbourhood.cells, full)) {
    compared.push({
      at,
      assist: await log.at("assist", at, false),
      precise: await log.at("precise", at, false),
    });
  }
  const clicked = await log.at("assist", AT_FLUSH, true);
  path.setMode("assist");
  const realHit = (step: Step, named: Assembly, held: Assembly): boolean =>
    step.hover !== null &&
    step.hover.accepted === false &&
    hitIsReal(
      step.hover.hit,
      placedItem,
      posed(named, poses.placed, poses.placedShift),
      posed(held, step.hover.pose, poses.heldShift),
    );
  const bothModes = (item: Compared, holds: (step: Step) => boolean): boolean =>
    holds(item.assist) && holds(item.precise);
  const describe = ({ at, assist, precise }: Compared): string =>
    `${describeOffset(at)}: assist ${outcome(assist)}; precise ${outcome(precise)}`;
  const flush = compared.filter(({ at }) => at.along === 0 && at.across === 0);
  const pressed = compared.filter(({ at }) => at.across > 0);
  const clear = compared.filter(({ at }) => at.across < 0);
  const checks: EditorCheck[] = [
    sweepCheck(
      "Pins against a solid edge: at every cursor offset assist gives exactly the precise result at the cursor pose, so it never relocates to an unmated free pose, and every refusal names a part and cell where the models overlap",
      compared,
      (item) =>
        stepVerdict(item.assist) === stepVerdict(item.precise) &&
        atCursor(item.assist, "assist") &&
        atCursor(item.precise, "precise") &&
        (item.precise.hover?.accepted === true || realHit(item.precise, solidParts, heldParts)),
      describe,
      `${compared.length} offsets, assist identical to precise at each`,
    ),
    sweepCheck(
      "Pins against a solid edge, flush: refused in both modes, naming a hole-free part of the solid module and the pin cell it hits, with no pin/hole joint, and the click places nothing",
      flush,
      (item) =>
        bothModes(
          item,
          (step) =>
            realHit(step, solidParts, pinsOf(heldParts)) &&
            pinHoleJoints(step.hover?.mates ?? []) === 0,
        ) &&
        clicked.refused &&
        clicked.committed === null,
      (item) => `${describe(item)}; clicked: ${outcome(clicked)}`,
      `refused in both modes: ${outcome(flush[0]?.assist ?? clicked)}`,
    ),
    sweepCheck(
      "Pins against a solid edge, pressed in by a stud or more: refused in both modes, naming a part and cell where the models overlap",
      pressed,
      (item) => bothModes(item, (step) => realHit(step, solidParts, heldParts)),
      describe,
      `${pressed.length} offsets, all refused with a real hit`,
    ),
    sweepCheck(
      "Pins against a solid edge, standing clear by a stud or more: accepted at the cursor pose in both modes, with no mates",
      clear,
      (item) =>
        bothModes(item, (step) => step.hover?.accepted === true && step.hover.mates.length === 0),
      describe,
      `${clear.length} offsets, all accepted with no mates`,
    ),
  ];
  return { placedLabel: "solid", checks, steps: log.steps };
}
