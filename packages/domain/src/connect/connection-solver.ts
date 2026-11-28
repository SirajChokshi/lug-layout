import { PLATE_LDU, isRot90 } from "@brr/math";
import type { CandidatePoses, LatticePose, SnapWindow } from "./candidate-poses.ts";
import type { MateFinder } from "./mate-finder.ts";
import type { MateReport } from "./mate-report.ts";
import type { ModelConnectors } from "./model-connectors.ts";
import { ProposalProgress } from "./proposal-progress.ts";

const QUARTER_TURNS = 4;
const POSE_INTS = 4;
const POSE_X = 0;
const POSE_Z = 1;
const POSE_Y_PLATES = 2;
const POSE_ROT = 3;
const INITIAL_WITHDRAWN = 64;

type WithdrawnPlacement = readonly [
  number,
  { readonly model: ModelConnectors; readonly pose: LatticePose },
];

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

class Withdrawal {
  count = 0;
  owed = false;
  private owners = new Int32Array(INITIAL_WITHDRAWN);
  private poses = new Int32Array(INITIAL_WITHDRAWN * POSE_INTS);
  private readonly models: ModelConnectors[] = [];
  private readonly pose = new CandidatePose();

  holds(placements: ReadonlyArray<WithdrawnPlacement>): boolean {
    if (placements.length !== this.count) return false;
    for (let k = 0; k < placements.length; k++) {
      const entry = placements[k];
      if (!entry) return false;
      const { model, pose } = entry[1];
      const at = k * POSE_INTS;
      if (
        this.owners[k] !== entry[0] ||
        this.models[k] !== model ||
        this.poses[at + POSE_X] !== pose.x ||
        this.poses[at + POSE_Z] !== pose.z ||
        this.poses[at + POSE_Y_PLATES] !== pose.yPlates ||
        this.poses[at + POSE_ROT] !== pose.rot
      ) {
        return false;
      }
    }
    return true;
  }

  record(placements: ReadonlyArray<WithdrawnPlacement>): void {
    if (this.owners.length < placements.length) {
      this.owners = new Int32Array(placements.length * 2);
      this.poses = new Int32Array(placements.length * 2 * POSE_INTS);
    }
    this.models.length = 0;
    for (let k = 0; k < placements.length; k++) {
      const entry = placements[k];
      if (!entry) continue;
      const { model, pose } = entry[1];
      const at = this.models.length * POSE_INTS;
      this.owners[this.models.length] = entry[0];
      this.poses[at + POSE_X] = pose.x;
      this.poses[at + POSE_Z] = pose.z;
      this.poses[at + POSE_Y_PLATES] = pose.yPlates;
      this.poses[at + POSE_ROT] = pose.rot;
      this.models.push(model);
    }
    this.count = this.models.length;
  }

  take(): number {
    const count = this.count;
    this.count = 0;
    this.owed = false;
    return count;
  }

  ownerAt(k: number): number {
    return this.owners[k] ?? 0;
  }

  modelAt(k: number): ModelConnectors | undefined {
    return this.models[k];
  }

  poseAt(k: number): LatticePose {
    const at = k * POSE_INTS;
    this.pose.x = this.poses[at + POSE_X] ?? 0;
    this.pose.z = this.poses[at + POSE_Z] ?? 0;
    this.pose.yPlates = this.poses[at + POSE_Y_PLATES] ?? 0;
    this.pose.rot = this.poses[at + POSE_ROT] ?? 0;
    return this.pose;
  }

  releaseModels(): void {
    this.models.length = 0;
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
  private readonly wholeProposal = new ProposalProgress();
  private readonly withdrawal = new Withdrawal();

  constructor(private readonly finders: ReadonlyArray<MateFinder>) {
    if (finders.length === 0) throw new RangeError("a connection solver needs at least one finder");
  }

  insert(model: ModelConnectors, pose: LatticePose, owner: number): void {
    this.reinsertWithdrawn();
    for (let f = 0; f < this.finders.length; f++) this.finders[f]?.insert(model, pose, owner);
  }

  remove(model: ModelConnectors, pose: LatticePose, owner: number): void {
    this.reinsertWithdrawn();
    for (let f = 0; f < this.finders.length; f++) this.finders[f]?.remove(model, pose, owner);
  }

  clear(): void {
    this.withdrawal.take();
    this.withdrawal.releaseModels();
    for (let f = 0; f < this.finders.length; f++) this.finders[f]?.clear();
  }

  withdrawn<T>(placements: ReadonlyArray<WithdrawnPlacement>, during: () => T): T {
    const withdrawal = this.withdrawal;
    if (withdrawal.owed && withdrawal.holds(placements)) {
      withdrawal.owed = false;
      for (let f = 0; f < this.finders.length; f++) this.finders[f]?.placedChanged();
    } else {
      if (withdrawal.count > 0 && !withdrawal.owed) {
        throw new Error("connectors are already withdrawn");
      }
      this.reinsertWithdrawn();
      for (let k = 0; k < placements.length; k++) {
        const entry = placements[k];
        if (!entry) continue;
        const { model, pose } = entry[1];
        for (let f = 0; f < this.finders.length; f++)
          this.finders[f]?.remove(model, pose, entry[0]);
      }
      withdrawal.record(placements);
    }
    try {
      return during();
    } finally {
      withdrawal.owed = withdrawal.count > 0;
    }
  }

  reinsertWithdrawn(): void {
    if (this.withdrawal.owed) this.reinsertOwed();
  }

  private reinsertOwed(): void {
    const withdrawal = this.withdrawal;
    const count = withdrawal.take();
    for (let k = 0; k < count; k++) {
      const model = withdrawal.modelAt(k);
      if (!model) continue;
      const pose = withdrawal.poseAt(k);
      const owner = withdrawal.ownerAt(k);
      for (let f = 0; f < this.finders.length; f++) this.finders[f]?.insert(model, pose, owner);
    }
    withdrawal.releaseModels();
  }

  rank(model: ModelConnectors, window: SnapWindow, out: CandidatePoses): void {
    this.reinsertWithdrawn();
    checkWindow(window);
    out.clear();
    out.add(window.x, window.z, window.yPlates, window.rot);
    for (let f = 0; f < this.finders.length; f++) this.finders[f]?.propose(model, window, out);
    for (let i = 0; i < out.count; i++) out.setVotes(i, this.votes(model, this.pose.read(out, i)));
    for (let i = 1; i < out.count; i++) {
      for (let j = i; j > 0 && ranksBefore(window, out, j, j - 1); j--) out.swap(j, j - 1);
    }
  }

  votes(model: ModelConnectors, pose: LatticePose): number {
    this.reinsertWithdrawn();
    return this.denseVotes(model, pose) + this.proposalVotes(model, pose);
  }

  denseVotes(model: ModelConnectors, pose: LatticePose): number {
    this.reinsertWithdrawn();
    let votes = 0;
    for (let f = 0; f < this.finders.length; f++) {
      const finder = this.finders[f];
      if (finder?.proposesEveryPose) votes += finder.count(model, pose);
    }
    return votes;
  }

  proposalVotes(model: ModelConnectors, pose: LatticePose): number {
    this.reinsertWithdrawn();
    let votes = 0;
    for (let f = 0; f < this.finders.length; f++) {
      const finder = this.finders[f];
      if (finder && !finder.proposesEveryPose) votes += finder.count(model, pose);
    }
    return votes;
  }

  proposeMates(model: ModelConnectors, window: SnapWindow, out: CandidatePoses): void {
    this.reinsertWithdrawn();
    this.wholeProposal.restart();
    this.proposeMatesFrom(model, window, out, this.wholeProposal, Number.POSITIVE_INFINITY);
  }

  proposeMatesFrom(
    model: ModelConnectors,
    window: SnapWindow,
    out: CandidatePoses,
    progress: ProposalProgress,
    slotBudget: number,
  ): boolean {
    this.reinsertWithdrawn();
    checkWindow(window);
    if (!progress.started) {
      out.clear();
      progress.started = true;
    }
    for (; progress.finder < this.finders.length; progress.finishFinder()) {
      const finder = this.finders[progress.finder];
      if (!finder || finder.proposesEveryPose) continue;
      if (!finder.proposeOnLattice(model, window, out, progress, slotBudget)) return false;
    }
    return true;
  }

  evaluate(model: ModelConnectors, pose: LatticePose, out: MateReport): void {
    this.reinsertWithdrawn();
    this.mates(model, pose, out, false);
  }

  partneredMates(model: ModelConnectors, pose: LatticePose, out: MateReport): void {
    this.reinsertWithdrawn();
    this.mates(model, pose, out, true);
  }

  private mates(
    model: ModelConnectors,
    pose: LatticePose,
    out: MateReport,
    partneredOnly: boolean,
  ): void {
    out.clear();
    for (let f = 0; f < this.finders.length; f++) {
      const finder = this.finders[f];
      if (!finder || (partneredOnly && !finder.namesPartners)) continue;
      const from = out.count;
      finder.mates(model, pose, out);
      out.assignFamily(from, f);
    }
  }
}
