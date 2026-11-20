import { STUD_LDU } from "@brr/math";
import type { GhostVerdict, WorldBox } from "@brr/render";
import type { FillView } from "./fill-tool.ts";
import {
  effectivePlacementMode,
  magnetMove,
  type MagnetMove,
  type PlacementModeView,
} from "./placement-mode.ts";
import {
  distinctJoints,
  type ConnectorKindView,
  type ConnectorSectionView,
  type HoverMateCount,
  type HoverRefusalHit,
  type PlacedModelView,
  type PlacementHover,
  type PlacementMode,
  type SectionProfile,
} from "./placement-hover.ts";

export type PlacementTone = "fits" | "mates" | "refused" | "pending";

export type ConnectorBadge = "inferred" | "unverified";

export interface BadgeCount {
  readonly badge: ConnectorBadge;
  readonly connectors: number;
}

export type PlacementLineKind =
  | "pending"
  | "refusal"
  | "joints"
  | "snap"
  | "mates"
  | "lift"
  | "turn";

export interface PlacementLine {
  readonly kind: PlacementLineKind;
  readonly text: string;
  readonly badges: ReadonlyArray<BadgeCount>;
}

export interface PlacementFeedback {
  readonly tone: PlacementTone;
  readonly mode: PlacementMode;
  readonly lines: ReadonlyArray<PlacementLine>;
}

export interface PlacementHoverInput {
  readonly refusal: string | null;
  readonly placement: PlacementHover | null;
}

export type PlacementGestureView =
  | { readonly kind: "box" }
  | { readonly kind: "move" | "paste"; readonly refusal: string | null };

type HeldGroupGesture = Extract<PlacementGestureView, { readonly kind: "move" | "paste" }>;

export interface PlacementView extends PlacementModeView {
  readonly mode: string;
  readonly hover: PlacementHoverInput | null;
  readonly ghostSettled: boolean;
  readonly gesture: PlacementGestureView | null;
  readonly fillDraft: FillView | null;
}

export interface SettleView extends PlacementModeView {
  readonly mode: string;
  readonly hover: { readonly x: number; readonly z: number } | null;
  readonly placements: number;
  readonly refusedClicks: number;
  readonly ghostRot: number;
  readonly activeItem: string | null;
  readonly ghostSettled: boolean;
}

const PLACE_MODE = "place";
const SELECT_MODE = "select";

function heldHover(view: PlacementView): PlacementHoverInput | null {
  if (view.mode !== PLACE_MODE || view.ghostSettled || view.fillDraft !== null) return null;
  return view.hover;
}

function heldGroup(view: PlacementView): HeldGroupGesture | null {
  const { gesture } = view;
  if (view.mode !== SELECT_MODE || gesture === null || gesture.kind === "box") return null;
  return gesture;
}

function chosenMode(view: PlacementView): PlacementMode {
  return effectivePlacementMode(view.placementMode, view.placementModeOverride);
}

function groupFeedback(view: PlacementView, group: HeldGroupGesture): PlacementFeedback {
  const mode = chosenMode(view);
  if (group.refusal === null) return { tone: "fits", mode, lines: NO_LINES };
  return { tone: "refused", mode, lines: [line("refusal", group.refusal)] };
}

function shownMode(view: PlacementView): PlacementMode {
  return view.hover?.placement?.mode ?? chosenMode(view);
}

function sameHeldCell(before: SettleView, after: SettleView): boolean {
  return (
    before.hover !== null &&
    after.hover !== null &&
    before.hover.x === after.hover.x &&
    before.hover.z === after.hover.z &&
    before.ghostRot === after.ghostRot &&
    before.activeItem === after.activeItem
  );
}

function sameAsk(before: SettleView, after: SettleView): boolean {
  return (
    before.placementMode === after.placementMode &&
    before.placementModeOverride === after.placementModeOverride &&
    before.refusedClicks === after.refusedClicks
  );
}

export function ghostSettles(before: SettleView, after: SettleView, dropping: boolean): boolean {
  if (after.mode !== PLACE_MODE || before.mode !== PLACE_MODE) return false;
  if (!sameHeldCell(before, after) || !sameAsk(before, after)) return false;
  if (after.placements !== before.placements)
    return dropping && after.placements > before.placements;
  return before.ghostSettled;
}

interface ConnectorNoun {
  readonly one: string;
  readonly many: string;
}

function noun(one: string): ConnectorNoun {
  return { one, many: `${one}s` };
}

const PIN = noun("pin");
const PIN_HOLE = noun("pin hole");
const AXLE = noun("axle");
const AXLE_HOLE = noun("axle hole");
const HINGE_FINGER = noun("hinge finger");
const SQUARE_PEG = noun("square peg");
const SQUARE_SOCKET = noun("square socket");
const ROUND_PEG = noun("round peg");
const ROUND_SOCKET = noun("round socket");
const NO_BADGES: ReadonlyArray<BadgeCount> = [];
const NO_LINES: ReadonlyArray<PlacementLine> = [];
const UNPLACEABLE = "Can't place here";
const FINDING_A_FIT = "Finding a fit…";

function hasProfile(kind: ConnectorKindView, profile: SectionProfile): boolean {
  return kind.sections.some((section) => section.profile === profile);
}

function counterbored(sections: ReadonlyArray<ConnectorSectionView>): boolean {
  const first = sections[0];
  const last = sections.at(-1);
  if (!first || !last || sections.length < 3) return false;
  const narrowest = Math.min(...sections.slice(1, -1).map((section) => section.sizeLdu));
  return narrowest < first.sizeLdu && narrowest < last.sizeLdu;
}

function connectorNoun(kind: ConnectorKindView): ConnectorNoun {
  const male = kind.gender === "male";
  if (hasProfile(kind, "axle")) return male ? AXLE : AXLE_HOLE;
  if (hasProfile(kind, "finger")) return HINGE_FINGER;
  if (male && hasProfile(kind, "flare")) return PIN;
  const allRound = kind.sections.every((section) => section.profile === "round");
  if (!male && kind.slides && allRound && counterbored(kind.sections)) return PIN_HOLE;
  if (hasProfile(kind, "square")) return male ? SQUARE_PEG : SQUARE_SOCKET;
  return male ? ROUND_PEG : ROUND_SOCKET;
}

function sharedNoun(kinds: ReadonlyArray<ConnectorKindView>): ConnectorNoun | null {
  const nouns = new Set(kinds.map(connectorNoun));
  const [only] = nouns;
  return nouns.size === 1 && only ? only : null;
}

function counted(count: number, what: ConnectorNoun): string {
  return `${count} ${count === 1 ? what.one : what.many}`;
}

function verb(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function modelNames(models: ReadonlyArray<PlacedModelView>): string | null {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const model of models) {
    const key = `${model.item}@${model.pose.x},${model.pose.yPlates},${model.pose.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(model.label || model.item);
  }
  const [first, second] = labels;
  if (first === undefined) return null;
  if (second === undefined) return first;
  return labels.length === 2 ? `${first} and ${second}` : `${first} and ${labels.length - 1} more`;
}

function plates(count: number): string {
  return `${count} ${count === 1 ? "plate" : "plates"}`;
}

function seamText(count: number, models: string | null, holesHeld: boolean): string {
  const lineUp = verb(count, "lines up flush", "line up flush");
  const goIn = `${counted(count, PIN)} ${verb(count, "goes in", "go in")}`;
  if (holesHeld)
    return `${counted(count, PIN_HOLE)} ${lineUp}${models ? ` with ${models}` : ""}, ${goIn}`;
  return `${counted(count, PIN_HOLE)}${models ? ` on ${models}` : ""} ${lineUp}, ${goIn}`;
}

interface MateWording {
  readonly held: ConnectorNoun;
  readonly partner: ConnectorNoun | null;
  readonly models: string | null;
  readonly female: boolean;
}

function mateWording(mate: HoverMateCount): MateWording {
  return {
    held: connectorNoun(mate.kind),
    partner: sharedNoun(mate.partnerKinds),
    models: modelNames(mate.partners),
    female: mate.kind.gender === "female",
  };
}

function wordingKey({ held, partner, models, female }: MateWording): string {
  return JSON.stringify([held.one, partner?.one ?? null, models, female]);
}

function mateText(count: number, { held, partner, models, female }: MateWording): string {
  const holes = female ? held : partner;
  const pegs = female ? partner : held;
  if (holes === PIN_HOLE && pegs === PIN) return seamText(count, models, female);
  if (held === HINGE_FINGER) {
    return `${counted(count, held)} ${verb(count, "interlocks", "interlock")}${models ? ` with ${models}` : ""}`;
  }
  if (female) {
    const taken = partner ? counted(count, partner) : "connectors";
    return `${counted(count, held)} ${verb(count, "takes", "take")} ${taken}${models ? ` from ${models}` : ""}`;
  }
  const target = partner ? `${counted(count, partner)}${models ? ` on ${models}` : ""}` : models;
  return target
    ? `${counted(count, held)} ${verb(count, "goes into", "go into")} ${target}`
    : `${counted(count, held)} ${verb(count, "goes in", "go in")}`;
}

function studSteps(move: MagnetMove): string | null {
  const most = Math.max(move.studsX, move.studsZ);
  const least = Math.min(move.studsX, move.studsZ);
  if (most === 0) return null;
  if (least === 0) return `${most} ${most === 1 ? "stud" : "studs"}`;
  return `${most} by ${least} studs`;
}

function moved(move: MagnetMove | null): move is MagnetMove {
  return move !== null && (move.studsX !== 0 || move.studsZ !== 0 || move.plates !== 0);
}

function jointsText(joints: number): string {
  return `Mates at ${joints} ${joints === 1 ? "joint" : "joints"}`;
}

function snapText(move: MagnetMove, mates: ReadonlyArray<HoverMateCount>): string {
  const met = sharedNoun(mates.flatMap((mate) => mate.partnerKinds));
  const steps: string[] = [];
  const studs = studSteps(move);
  if (studs !== null) steps.push(studs);
  if (move.plates !== 0) {
    steps.push(`${plates(Math.abs(move.plates))} ${move.plates > 0 ? "up" : "down"}`);
  }
  const snapped = `Snapped ${steps.join(" and ")}`;
  return met ? `${snapped} to meet the ${met.many}` : `${snapped} to mate`;
}

function turnText(turnMates: ReadonlyArray<HoverMateCount>): string {
  const met = sharedNoun(turnMates.flatMap((mate) => mate.partnerKinds));
  return met ? `Turn it to meet the ${met.many}` : "Turn it to snap here";
}

function refusalText(hit: HoverRefusalHit): string {
  const part = hit.partLabel || hit.part;
  const model = hit.placed.label || hit.placed.item;
  const cell = `cell (${hit.cellX}, ${hit.cellZ})`;
  if (hit.byColumnOnly) {
    return `Hits the column of ${model} at ${cell}, though no part is in that height band (column check)`;
  }
  return part === null ? `Hits ${model} at ${cell}` : `Hits ${part} in ${model} at ${cell}`;
}

function badgesOf(mates: ReadonlyArray<HoverMateCount>): ReadonlyArray<BadgeCount> {
  let inferred = 0;
  let unverified = 0;
  for (const mate of mates) {
    inferred += mate.inferred;
    unverified += mate.unverified;
  }
  const badges: BadgeCount[] = [];
  if (inferred > 0) badges.push({ badge: "inferred", connectors: inferred });
  if (unverified > 0) badges.push({ badge: "unverified", connectors: unverified });
  return badges.length > 0 ? badges : NO_BADGES;
}

function joined(mates: ReadonlyArray<HoverMateCount>): ReadonlyArray<HoverMateCount> {
  return mates.filter((mate) => mate.joints > 0);
}

function mateLines(mates: ReadonlyArray<HoverMateCount>): PlacementLine[] {
  const alike = new Map<
    string,
    { readonly wording: MateWording; readonly mates: HoverMateCount[] }
  >();
  for (const mate of mates) {
    const wording = mateWording(mate);
    const key = wordingKey(wording);
    const group = alike.get(key);
    if (group) group.mates.push(mate);
    else alike.set(key, { wording, mates: [mate] });
  }
  return [...alike.values()].map(({ wording, mates: group }) => ({
    kind: "mates",
    text: mateText(distinctJoints(group), wording),
    badges: badgesOf(group),
  }));
}

function line(kind: PlacementLineKind, text: string): PlacementLine {
  return { kind, text, badges: NO_BADGES };
}

function searching(placement: PlacementHover | null): boolean {
  return placement !== null && placement.mode === "assist" && !placement.settled;
}

function placementTone(hover: PlacementHoverInput): PlacementTone {
  const { placement } = hover;
  if (searching(placement)) return "pending";
  if (!placement) return hover.refusal === null ? "fits" : "refused";
  if (!placement.accepted) return "refused";
  return joined(placement.mates).length > 0 ? "mates" : "fits";
}

function turnToSnap(placement: PlacementHover): boolean {
  return placement.turnSettled && placement.turnBlocksSnap;
}

function placementLines(hover: PlacementHoverInput, placement: PlacementHover): PlacementLine[] {
  const lines: PlacementLine[] = [];
  if (!placement.accepted) {
    const reason = placement.hit ? refusalText(placement.hit) : (hover.refusal ?? UNPLACEABLE);
    lines.push(line("refusal", reason));
  } else {
    const mates = joined(placement.mates);
    const kindLines = mateLines(mates);
    if (kindLines.length > 1) lines.push(line("joints", jointsText(placement.joints)));
    const move = magnetMove(placement);
    if (moved(move) && mates.length > 0) lines.push(line("snap", snapText(move, mates)));
    lines.push(...kindLines);
    if (placement.lifted && placement.pose.yPlates > 0) {
      const on = modelNames(placement.restsOn);
      lines.push(
        line("lift", `Lands ${plates(placement.pose.yPlates)} up${on ? ` on ${on}` : ""}`),
      );
    }
  }
  if (turnToSnap(placement)) {
    const { turnMates } = placement;
    lines.push({ kind: "turn", text: turnText(turnMates), badges: badgesOf(turnMates) });
  }
  return lines;
}

const feedbackShown = new WeakMap<PlacementView, PlacementFeedback | null>();

export function placementFeedback(view: PlacementView): PlacementFeedback | null {
  const known = feedbackShown.get(view);
  if (known !== undefined) return known;
  const feedback = feedbackOf(view);
  feedbackShown.set(view, feedback);
  return feedback;
}

function feedbackOf(view: PlacementView): PlacementFeedback | null {
  const group = heldGroup(view);
  if (group) return groupFeedback(view, group);
  const hover = heldHover(view);
  if (!hover) return null;
  const tone = placementTone(hover);
  const mode = shownMode(view);
  const { placement } = hover;
  if (tone === "pending") {
    return { tone, mode, lines: [line("pending", FINDING_A_FIT)] };
  }
  if (placement) {
    return {
      tone,
      mode,
      lines: placementLines(hover, placement),
    };
  }
  return {
    tone,
    mode,
    lines: hover.refusal === null ? [] : [line("refusal", hover.refusal)],
  };
}

export function badgeText(badge: BadgeCount): string {
  return `${badge.connectors} ${badge.badge}`;
}

export function lineText(placementLine: PlacementLine): string {
  if (placementLine.badges.length === 0) return placementLine.text;
  return `${placementLine.text} (${placementLine.badges.map(badgeText).join(", ")})`;
}

function hitBox(hit: HoverRefusalHit): WorldBox | null {
  const bottom = Math.max(hit.placedBottomLdu, hit.heldBottomLdu);
  const top = Math.min(hit.placedTopLdu, hit.heldTopLdu);
  if (!(bottom < top)) return null;
  return {
    minX: hit.cellX * STUD_LDU,
    minY: bottom,
    minZ: hit.cellZ * STUD_LDU,
    maxX: (hit.cellX + 1) * STUD_LDU,
    maxY: top,
    maxZ: (hit.cellZ + 1) * STUD_LDU,
  };
}

export function ghostVerdict(view: PlacementView): GhostVerdict | null {
  const group = heldGroup(view);
  if (group) {
    const tone = group.refusal === null ? "fits" : "refused";
    return { tone, hit: null, precise: chosenMode(view) === "precise" };
  }
  const { hover } = view;
  if (view.mode !== PLACE_MODE || hover === null || view.fillDraft !== null) return null;
  const precise = shownMode(view) === "precise";
  const tone = placementTone(hover);
  if (view.ghostSettled || tone === "pending") return { tone: null, hit: null, precise };
  const hit = hover.placement?.accepted === false ? hover.placement.hit : null;
  return { tone, hit: hit ? hitBox(hit) : null, precise };
}

function sameBox(a: WorldBox | null, b: WorldBox | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.minX === b.minX &&
    a.minY === b.minY &&
    a.minZ === b.minZ &&
    a.maxX === b.maxX &&
    a.maxY === b.maxY &&
    a.maxZ === b.maxZ
  );
}

export function sameVerdict(a: GhostVerdict | null, b: GhostVerdict | null): boolean {
  if (a === null || b === null) return a === b;
  return a.tone === b.tone && a.precise === b.precise && sameBox(a.hit, b.hit);
}
