import { PLATE_LDU, isRot90 } from "@brr/math";
import type { CandidatePoses, LatticePose, SnapWindow } from "./candidate-poses.ts";
import type { MateFinder } from "./mate-finder.ts";
import type { MateReport } from "./mate-report.ts";
import type { ModelConnectors } from "./model-connectors.ts";

const QUARTER_TURNS = 4;

class CandidatePose implements LatticePose {
  x = 0;
  z = 0;
  yPlates = 0;
  rot = 0;

  read(candidates: CandidatePoses, index: number): this {
    this.x = candidates.x[index] ?? 0;
    this.z = candidates.z[index] ?? 0;
    this.yPlates = candidates.yPlates[index] ?? 0;
    this.rot = candidates.rot[index] ?? 0;
    return this;
  }
}

function checkWindow(window: SnapWindow): void {
  const whole =
    Number.isInteger(window.cells) &&
    Number.isInteger(window.plates) &&
    Number.isInteger(window.turns) &&
    window.cells >= 0 &&
    window.plates >= 0 &&
    window.turns >= 1 &&
    window.turns <= QUARTER_TURNS;
  if (!whole || !isRot90(window.rot)) {
    throw new RangeError(
      `snap window of ${window.cells} cells, ${window.plates} plates and ${window.turns} turns from rotation ${window.rot} is not valid`,
    );
  }
}

function distanceFrom(window: SnapWindow, candidates: CandidatePoses, index: number): number {
  return (
    Math.abs((candidates.x[index] ?? 0) - window.x) +
    Math.abs((candidates.z[index] ?? 0) - window.z) +
    Math.abs((candidates.yPlates[index] ?? 0) - window.yPlates) * PLATE_LDU
  );
}

function turnsFrom(window: SnapWindow, candidates: CandidatePoses, index: number): number {
  return ((candidates.rot[index] ?? 0) - window.rot + QUARTER_TURNS) % QUARTER_TURNS;
}

function ranksBefore(
  window: SnapWindow,
  candidates: CandidatePoses,
  a: number,
  b: number,
): boolean {
  const votes = (candidates.votes[a] ?? 0) - (candidates.votes[b] ?? 0);
  if (votes !== 0) return votes > 0;
  const distance = distanceFrom(window, candidates, a) - distanceFrom(window, candidates, b);
  if (distance !== 0) return distance < 0;
  return turnsFrom(window, candidates, a) < turnsFrom(window, candidates, b);
}

export class ConnectionSolver {
  private readonly pose = new CandidatePose();

  constructor(private readonly finders: ReadonlyArray<MateFinder>) {
    if (finders.length === 0) throw new RangeError("a connection solver needs at least one finder");
  }

  insert(model: ModelConnectors, pose: LatticePose): void {
    for (let f = 0; f < this.finders.length; f++) this.finders[f]?.insert(model, pose);
  }

  remove(model: ModelConnectors, pose: LatticePose): void {
    for (let f = 0; f < this.finders.length; f++) this.finders[f]?.remove(model, pose);
  }

  rank(model: ModelConnectors, window: SnapWindow, out: CandidatePoses): void {
    checkWindow(window);
    out.clear();
    out.add(window.x, window.z, window.yPlates, window.rot);
    for (let f = 0; f < this.finders.length; f++) this.finders[f]?.propose(model, window, out);
    for (let i = 0; i < out.count; i++) {
      const pose = this.pose.read(out, i);
      let votes = 0;
      for (let f = 0; f < this.finders.length; f++)
        votes += this.finders[f]?.count(model, pose) ?? 0;
      out.setVotes(i, votes);
    }
    for (let i = 1; i < out.count; i++) {
      for (let j = i; j > 0 && ranksBefore(window, out, j, j - 1); j--) out.swap(j, j - 1);
    }
  }

  evaluate(model: ModelConnectors, pose: LatticePose, out: MateReport): void {
    out.clear();
    for (let f = 0; f < this.finders.length; f++) {
      const from = out.count;
      this.finders[f]?.mates(model, pose, out);
      out.assignFamily(from, f);
    }
  }
}
