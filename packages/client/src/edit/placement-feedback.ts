import { STUD_LDU } from "@brr/math";
import type { GhostVerdict, WorldBox } from "@brr/render";
import type {
  ConnectorKindView,
  ConnectorSectionView,
  HoverMateCount,
  HoverRefusalHit,
  PlacedModelView,
  PlacementHover,
  SectionProfile,
} from "./placement-hover.ts";

export type PlacementTone = "fits" | "mates" | "refused";

export type ConnectorBadge = "inferred" | "unverified";

export interface BadgeCount {
  readonly badge: ConnectorBadge;
  readonly connectors: number;
}

export type PlacementLineKind = "refusal" | "mates" | "lift" | "turn";

export interface PlacementLine {
  readonly kind: PlacementLineKind;
  readonly text: string;
  readonly badges: ReadonlyArray<BadgeCount>;
}

export interface PlacementFeedback {
  readonly tone: PlacementTone;
  readonly lines: ReadonlyArray<PlacementLine>;
  readonly turnToSnap: boolean;
}

export interface PlacementHoverInput {
  readonly refusal: string | null;
  readonly placement: PlacementHover | null;
}

export interface PlacementView {
  readonly mode: string;
  readonly hover: PlacementHoverInput | null;
}

const PLACE_MODE = "place";

function heldHover(view: PlacementView): PlacementHoverInput | null {
  return view.mode === PLACE_MODE ? view.hover : null;
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
const UNPLACEABLE = "Can't place here";

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

function mateText(mate: HoverMateCount): string {
  const count = mate.joints > 0 ? mate.joints : mate.connectors;
  const held = connectorNoun(mate.kind);
  const partner = sharedNoun(mate.partnerKinds);
  const models = modelNames(mate.partners);
  if (held === HINGE_FINGER) {
    return `${counted(count, held)} ${verb(count, "interlocks", "interlock")}${models ? ` with ${models}` : ""}`;
  }
  const goIn = verb(count, "goes in", "go in");
  const lineUp = verb(count, "lines up flush", "line up flush");
  if (mate.kind.gender === "female") {
    const lined = `${counted(count, held)} ${lineUp}${models ? ` with ${models}` : ""}`;
    return partner ? `${lined}, ${counted(count, partner)} ${goIn}` : lined;
  }
  if (partner) {
    return `${counted(count, partner)}${models ? ` on ${models}` : ""} ${lineUp}, ${counted(count, held)} ${goIn}`;
  }
  return models
    ? `${counted(count, held)} ${verb(count, "goes into", "go into")} ${models}`
    : `${counted(count, held)} ${goIn}`;
}

function turnText(turnMates: ReadonlyArray<HoverMateCount>): string {
  const met = sharedNoun(turnMates.flatMap((mate) => mate.partnerKinds));
  return met ? `Turn it to meet the ${met.many}` : "Turn it to snap here";
}

function refusalText(hit: HoverRefusalHit): string {
  const part = hit.partLabel ?? hit.part ?? "a part";
  const model = hit.placed.label || hit.placed.item;
  return `Hits ${part} in ${model} at cell (${hit.cellX}, ${hit.cellZ})`;
}

function badgesOf(mate: HoverMateCount): ReadonlyArray<BadgeCount> {
  const badges: BadgeCount[] = [];
  if (mate.inferred > 0) badges.push({ badge: "inferred", connectors: mate.inferred });
  if (mate.unverified > 0) badges.push({ badge: "unverified", connectors: mate.unverified });
  return badges.length > 0 ? badges : NO_BADGES;
}

function line(kind: PlacementLineKind, text: string): PlacementLine {
  return { kind, text, badges: NO_BADGES };
}

function placementTone(hover: PlacementHoverInput): PlacementTone {
  const { placement } = hover;
  if (!placement) return hover.refusal === null ? "fits" : "refused";
  if (!placement.accepted) return "refused";
  return placement.mates.length > 0 ? "mates" : "fits";
}

function placementLines(hover: PlacementHoverInput, placement: PlacementHover): PlacementLine[] {
  const lines: PlacementLine[] = [];
  if (!placement.accepted) {
    const reason = placement.hit ? refusalText(placement.hit) : (hover.refusal ?? UNPLACEABLE);
    lines.push(line("refusal", reason));
  } else {
    for (const mate of placement.mates) {
      lines.push({ kind: "mates", text: mateText(mate), badges: badgesOf(mate) });
    }
    if (placement.lifted) {
      const on = modelNames(placement.restsOn);
      lines.push(
        line("lift", `Lands ${plates(placement.pose.yPlates)} up${on ? ` on ${on}` : ""}`),
      );
    }
  }
  if (placement.turnBlocksSnap) lines.push(line("turn", turnText(placement.turnMates)));
  return lines;
}

export function placementFeedback(view: PlacementView): PlacementFeedback | null {
  const hover = heldHover(view);
  if (!hover) return null;
  const tone = placementTone(hover);
  const { placement } = hover;
  if (placement) {
    return {
      tone,
      lines: placementLines(hover, placement),
      turnToSnap: placement.turnBlocksSnap,
    };
  }
  return {
    tone,
    lines: hover.refusal === null ? [] : [line("refusal", hover.refusal)],
    turnToSnap: false,
  };
}

export function badgeText(badge: BadgeCount): string {
  return `${badge.connectors} ${badge.badge}`;
}

export function lineText(placementLine: PlacementLine): string {
  if (placementLine.badges.length === 0) return placementLine.text;
  return `${placementLine.text} (${placementLine.badges.map(badgeText).join(", ")})`;
}

function hitBox(hit: HoverRefusalHit): WorldBox {
  const bottom = Math.max(hit.placedBottomLdu, hit.heldBottomLdu);
  const top = Math.min(hit.placedTopLdu, hit.heldTopLdu);
  const overlaps = bottom < top;
  return {
    minX: hit.cellX * STUD_LDU,
    minY: overlaps ? bottom : hit.placedBottomLdu,
    minZ: hit.cellZ * STUD_LDU,
    maxX: (hit.cellX + 1) * STUD_LDU,
    maxY: overlaps ? top : hit.placedTopLdu,
    maxZ: (hit.cellZ + 1) * STUD_LDU,
  };
}

export function ghostVerdict(view: PlacementView): GhostVerdict | null {
  const hover = heldHover(view);
  if (!hover) return null;
  const hit = hover.placement?.accepted === false ? hover.placement.hit : null;
  return { tone: placementTone(hover), hit: hit ? hitBox(hit) : null };
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
  return a.tone === b.tone && sameBox(a.hit, b.hit);
}
