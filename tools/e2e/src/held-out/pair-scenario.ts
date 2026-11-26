import {
  collisions,
  pinOutcomes,
  translated,
  type Assembly,
  type AssemblyPart,
  type PinOutcome,
  type Vec3,
} from "./assembly.ts";
import type { ModulePair } from "./generator.ts";

const AXIS_NAMES = ["x", "y", "z"] as const;
const SHIFTED_POSES = [
  { sign: 1, name: "one stud forward along the edge" },
  { sign: -1, name: "one stud back along the edge" },
] as const;

function shiftedOffset(pair: ModulePair, sign: number): Vec3 {
  return [
    pair.partnerOffset[0] + sign * pair.alongEdge[0],
    pair.partnerOffset[1] + sign * pair.alongEdge[1],
    pair.partnerOffset[2] + sign * pair.alongEdge[2],
  ];
}

function pinName(part: AssemblyPart, index: number, count: number): string {
  const pin = part.pin;
  if (!pin) return `part ${part.reference}`;
  const [first, second] = [0, 1, 2].filter((axis) => axis !== pin.axis);
  return `pin ${index + 1} of ${count} (${part.reference} on the ${AXIS_NAMES[pin.axis]} line at ${AXIS_NAMES[first ?? 0]} ${pin.at[0]}, ${AXIS_NAMES[second ?? 0]} ${pin.at[1]})`;
}

function references(parts: ReadonlyArray<AssemblyPart>): string {
  return parts.map((part) => part.reference).join(" and ");
}

function contact(outcome: PinOutcome): string {
  switch (outcome.kind) {
    case "inHole":
      return `engages a hole in ${references(outcome.holders)}`;
    case "colliding":
      return `collides with ${references(outcome.blockers)}`;
    case "free":
      return "misses every hole, touching no partner part";
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled pin outcome ${String(unhandled)}`);
    }
  }
}

function described(outcomes: ReadonlyArray<PinOutcome>): string[] {
  return outcomes.map(
    (outcome, index) => `${pinName(outcome.pin, index, outcomes.length)} ${contact(outcome)}`,
  );
}

export function shiftedOutcomes(pair: ModulePair, sign: number): ReadonlyArray<PinOutcome> {
  const partner: Assembly = translated(pair.partner.assembly, shiftedOffset(pair, sign));
  return pinOutcomes(pair.subject.assembly, partner);
}

export type SeamFit = "mated" | "free" | "out";

export interface SeamPrediction {
  readonly along: number;
  readonly fit: SeamFit;
  readonly joints: number;
}

export function seamPredictions(pair: ModulePair, span: number): ReadonlyArray<SeamPrediction> {
  const predictions: SeamPrediction[] = [];
  for (let along = -span; along <= span; along++) {
    const partner = translated(pair.partner.assembly, shiftedOffset(pair, along));
    const outcomes = pinOutcomes(pair.subject.assembly, partner);
    const out = outcomes.some((outcome) => outcome.kind === "colliding");
    const joints = outcomes.filter((outcome) => outcome.kind === "inHole").length;
    predictions.push({
      along: along + 0,
      fit: out ? "out" : joints > 0 ? "mated" : "free",
      joints,
    });
  }
  return predictions;
}

export function solidShiftCollides(pair: ModulePair, sign: number): boolean {
  const solid: Assembly = translated(pair.solidPartner.assembly, shiftedOffset(pair, sign));
  return pinOutcomes(pair.subject.assembly, solid).some((outcome) => outcome.kind === "colliding");
}

export function scenarioProblems(pair: ModulePair): string[] {
  const problems: string[] = [];
  const { subject, partner, partnerOffset } = pair;
  if (pair.pins === 0) problems.push("the subject has no pin on its paired edge");
  if (collisions(subject.assembly) !== 0) problems.push("the subject's own parts collide");
  if (collisions(partner.assembly) !== 0) problems.push("the partner's own parts collide");
  const aligned = translated(partner.assembly, partnerOffset);
  const alignedCollisions = collisions(subject.assembly, aligned);
  if (alignedCollisions !== 0) {
    problems.push(`aligned: ${alignedCollisions} subject and partner part pairs collide`);
  }
  const atAligned = pinOutcomes(subject.assembly, aligned);
  if (atAligned.length !== pair.pins) {
    problems.push(`aligned: the subject has ${atAligned.length} pins, not the pair's ${pair.pins}`);
  }
  const alignedLines = described(atAligned);
  atAligned.forEach((outcome, index) => {
    if (outcome.kind !== "inHole") problems.push(`aligned: ${alignedLines[index]}`);
  });
  for (const pose of SHIFTED_POSES) {
    const outcomes = shiftedOutcomes(pair, pose.sign);
    if (outcomes.length > 0 && outcomes.every((outcome) => outcome.kind === "inHole")) {
      problems.push(
        `${pose.name}: every pin engages a hole with none colliding or missing (${described(outcomes).join("; ")})`,
      );
    }
  }
  return problems;
}
