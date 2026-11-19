import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type {
  ConnectorKindView,
  HoverMateCount,
  HoverRefusalHit,
  IEditor,
  PlacementHover,
} from "@brr/client";
import type { Assembly, AssemblyPart } from "./assembly.ts";
import type { ModulePair } from "./generator.ts";
import { shiftedOutcomes } from "./pair-scenario.ts";
import type { AimedBackend } from "./headless-editor.ts";

const PICK_RADIUS_CELLS = 2;
const FIRST_STEP_BEYOND_RADIUS = PICK_RADIUS_CELLS + 1;
const QUARTER_TURNS_AWAY = 2;
const QUARTER_TURNS = 4;
const MODEL_IDENTITY_KEYS = new Set(["item", "label"]);
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

function isTechnicHole(kind: ConnectorKindView): boolean {
  return kind.gender === "female" && kind.slides && kind.sections.length > 0 && roundSections(kind);
}

function isTechnicPin(kind: ConnectorKindView): boolean {
  return kind.gender === "male" && kind.sections.length > 0 && roundSections(kind);
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
  return `${verdict} at ${describePose(hover.pose)}${hover.lifted ? ", lifted" : ""}${hit}; ${describeMates(hover.mates)}`;
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

  hoverAt(
    x: number,
    z: number,
  ): { readonly hover: PlacementHover | null; readonly text: string | null } {
    this.backend.aim(x, z);
    this.editor.pointerMove(0, 0);
    const hover = this.editor.snapshot().hover;
    return { hover: hover?.placement ?? null, text: hover?.refusal ?? null };
  }

  step(x: number, z: number, commit: boolean): Step {
    const { hover, text } = this.hoverAt(x, z);
    const before = this.editor.snapshot();
    const aim: Pose = { x, z, yPlates: 0, rot: before.ghostRot };
    if (!commit)
      return { aim, hover, hoverText: text, committed: null, refused: false, refusal: null };
    this.editor.click(0, 0, NO_TIME);
    const after = this.editor.snapshot();
    const refused = after.refusedClicks > before.refusedClicks;
    const committed = after.placements > before.placements ? this.lastPlacement() : null;
    return {
      aim,
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

export interface PairPoses {
  readonly placed: Pose;
  readonly placedShift: Vec3;
  readonly heldShift: Vec3;
  readonly flush: Pose;
  readonly toward: Vec3;
  readonly along: Vec3;
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

function overlapsHit(part: AssemblyPart, origin: Vec3, box: HitBox): boolean {
  const x0 = box.cellX * STUD_LDU;
  const z0 = box.cellZ * STUD_LDU;
  return (
    origin[0] + part.min[0] < x0 + STUD_LDU &&
    origin[0] + part.max[0] > x0 &&
    origin[2] - part.max[2] < z0 + STUD_LDU &&
    origin[2] - part.min[2] > z0 &&
    origin[1] - part.max[1] < box.topLdu &&
    origin[1] - part.min[1] > box.bottomLdu
  );
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
    ) && held.parts.some((part) => overlapsHit(part, held.origin, box))
  );
}

export async function pinnedPairChecks(
  path: EditorPath,
  poses: PairPoses,
  pair: ModulePair,
  placedItem: string,
  heldItem: string,
): Promise<PairRun> {
  const { pins } = pair;
  const placedParts = pair.subject.assembly;
  const steps: Array<{ readonly label: string; readonly step: Step }> = [];
  const run = async (label: string, pose: Pose, commit: boolean): Promise<Step> => {
    await path.hold(heldItem);
    const step = path.step(pose.x, pose.z, commit);
    steps.push({ label, step });
    if (step.committed) path.undoLast();
    return step;
  };
  const short = await run("one stud short", offset(poses.flush, poses.toward, -1), true);
  const inOne = await run("one stud in", offset(poses.flush, poses.toward, 1), true);
  const beyond = await run(
    `${FIRST_STEP_BEYOND_RADIUS} studs in, the first step beyond the pick radius`,
    offset(poses.flush, poses.toward, FIRST_STEP_BEYOND_RADIUS),
    true,
  );
  const alongForward = await run(
    "one stud along the edge",
    offset(poses.flush, poses.along, 1),
    true,
  );
  const alongBack = await run(
    "one stud back along the edge",
    offset(poses.flush, poses.along, -1),
    true,
  );
  const engagedAll = (step: Step) =>
    step.hover !== null && pinHoleJoints(step.hover.mates) === pins;
  const flushSnap = (step: Step) =>
    step.hover?.accepted === true &&
    samePose(step.hover.pose, poses.flush) &&
    !step.hover.lifted &&
    engagedAll(step) &&
    samePose(step.committed, poses.flush);
  const shiftedAllowed = (step: Step, sign: number) => {
    if (!samePose(step.committed, offset(poses.flush, poses.along, sign))) return true;
    if (shiftedOutcomes(pair, sign).some((outcome) => outcome.kind === "colliding")) return false;
    return step.hover !== null && pinHoleJoints(step.hover.mates) < pins;
  };
  const beyondHit = beyond.hover?.hit ?? null;
  const checks: EditorCheck[] = [
    {
      label: "From one stud short, it snaps flush with every pin engaged",
      passed: flushSnap(short),
      detail: `expected ${describePose(poses.flush)} with ${pins} pin/hole joints; hover ${describeHover(short.hover)}; committed ${describePose(short.committed)}`,
    },
    {
      label: "One stud in never commits the overlapping pose: within the radius it snaps flush",
      passed: flushSnap(inOne),
      detail: `hover ${describeHover(inOne.hover)}; committed ${describePose(inOne.committed)}`,
    },
    {
      label: `Beyond the radius (${FIRST_STEP_BEYOND_RADIUS} studs in), it's refused, naming the part and cell it hits`,
      passed:
        beyond.committed === null &&
        beyond.refused &&
        beyond.hover?.accepted === false &&
        hitIsReal(
          beyondHit,
          placedItem,
          posed(placedParts, poses.placed, poses.placedShift),
          posed(pair.partner.assembly, beyond.hover.pose, poses.heldShift),
        ),
      detail: `hover ${describeHover(beyond.hover)}; ${beyond.refused ? `refused: ${beyond.refusal ?? "no reason"}` : `committed ${describePose(beyond.committed)}`}`,
    },
    {
      label:
        "One stud along the edge either way, at least one pin collides or misses: a colliding shifted pose is never committed, and a missing one never with every pin engaged",
      passed: shiftedAllowed(alongForward, 1) && shiftedAllowed(alongBack, -1),
      detail: `forward: hover ${describeHover(alongForward.hover)}, committed ${describePose(alongForward.committed)}; back: hover ${describeHover(alongBack.hover)}, committed ${describePose(alongBack.committed)}`,
    },
  ];
  return { placedLabel: "pinned", checks, steps };
}

export async function holesAgainstHolesCheck(
  path: EditorPath,
  poses: PairPoses,
  heldItem: string,
): Promise<EditorCheck> {
  await path.hold(heldItem);
  const step = path.step(poses.flush.x, poses.flush.z, true);
  if (step.committed) path.undoLast();
  const passed =
    step.hover?.accepted === true &&
    !step.hover.lifted &&
    step.hover.hit === null &&
    samePose(step.committed, poses.flush);
  return {
    label: "Holes against holes place flush",
    passed,
    detail: `expected ${describePose(poses.flush)}; hover ${describeHover(step.hover)}; committed ${describePose(step.committed)}`,
  };
}

export async function turnedAwayCheck(
  path: EditorPath,
  poses: PairPoses,
  heldItem: string,
): Promise<EditorCheck> {
  await path.hold(heldItem, QUARTER_TURNS_AWAY);
  const aim = offset(poses.flush, poses.toward, -1);
  const step = path.step(aim.x, aim.z, false);
  await path.hold(heldItem, 0);
  const joints = step.hover ? pinHoleJoints(step.hover.mates) : 0;
  return {
    label: "Turned so the holes face away from the pins, nothing snaps",
    passed: step.hover !== null && joints === 0,
    detail: `held turned ${QUARTER_TURNS_AWAY} quarter turns, aimed one stud short; hover ${describeHover(step.hover)}${step.hover?.turnBlocksSnap ? `; a quarter turn would snap: ${describeMates(step.hover.turnMates)}` : ""}`,
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
  return differences;
}

export async function cornerModuleCheck(
  path: EditorPath,
  templateItem: string,
  templatePose: Pose,
  moduleItem: string,
  offsetFromTemplate: Vec3,
  pins: number,
): Promise<EditorCheck> {
  const templateShift = path.frameShift(templateItem);
  const moduleShift = path.frameShift(moduleItem);
  const worldOffset = fromLdrawFrame(offsetFromTemplate);
  const flush: Pose = {
    x: templatePose.x + templateShift[0] + worldOffset[0] - moduleShift[0],
    z: templatePose.z + templateShift[2] + worldOffset[2] - moduleShift[2],
    yPlates: templatePose.yPlates,
    rot: templatePose.rot,
  };
  const toward: Vec3 = [
    -Math.sign(worldOffset[0]) * STUD_LDU,
    0,
    -Math.sign(worldOffset[2]) * STUD_LDU,
  ];
  await path.hold(moduleItem, 0);
  const aim = offset(flush, toward, -1);
  const step = path.step(aim.x, aim.z, true);
  if (step.committed) path.undoLast();
  return {
    label:
      "A generated module with corner Technic joins mates an official template: from one stud short it snaps flush with every pin engaged",
    passed:
      step.hover?.accepted === true &&
      samePose(step.hover.pose, flush) &&
      !step.hover.lifted &&
      pinHoleJoints(step.hover.mates) === pins &&
      samePose(step.committed, flush),
    detail: `expected ${describePose(flush)} with ${pins} pin/hole joints; hover ${describeHover(step.hover)}; committed ${describePose(step.committed)}`,
  };
}

export async function solidEdgeChecks(
  path: EditorPath,
  poses: PairPoses,
  solid: { readonly assembly: Assembly; readonly edgeRow: Assembly },
  heldParts: Assembly,
  placedItem: string,
  heldItem: string,
): Promise<PairRun> {
  const steps: Array<{ readonly label: string; readonly step: Step }> = [];
  const run = async (label: string, pose: Pose): Promise<Step> => {
    await path.hold(heldItem, 0);
    const step = path.step(pose.x, pose.z, true);
    steps.push({ label, step });
    if (step.committed) path.undoLast();
    return step;
  };
  const flush = await run("flush", poses.flush);
  const inOne = await run("one stud in", offset(poses.flush, poses.toward, 1));
  const refusedAt = (step: Step, named: Assembly, held: Assembly) =>
    step.committed === null &&
    step.refused &&
    step.hover?.accepted === false &&
    pinHoleJoints(step.hover.mates) === 0 &&
    hitIsReal(
      step.hover.hit,
      placedItem,
      posed(named, poses.placed, poses.placedShift),
      posed(held, step.hover.pose, poses.heldShift),
    );
  const checks: EditorCheck[] = [
    {
      label: "Pins against a solid edge, flush: refused, naming the brick and cell the pins hit",
      passed: refusedAt(flush, solid.edgeRow, pinsOf(heldParts)),
      detail: solidDetail(flush),
    },
    {
      label:
        "Pins against a solid edge, one stud in: refused, naming the part and cell it hits, with no snap",
      passed: refusedAt(inOne, solid.assembly, heldParts),
      detail: solidDetail(inOne),
    },
  ];
  return { placedLabel: "solid", checks, steps };
}

function solidDetail(step: Step): string {
  const outcome = step.refused
    ? `refused: ${step.refusal ?? "no reason"}`
    : `committed ${describePose(step.committed)}`;
  return `aimed ${describePose(step.aim)}; hover ${describeHover(step.hover)}; ${outcome}`;
}
