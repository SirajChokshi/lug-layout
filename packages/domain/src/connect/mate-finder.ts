import type { CandidatePoses, LatticePose, SnapWindow } from "./candidate-poses.ts";
import type { MateReport } from "./mate-report.ts";
import type { ModelConnectors } from "./model-connectors.ts";

export interface MateFinder {
  readonly namesPartners: boolean;
  readonly proposesEveryPose: boolean;
  insert(model: ModelConnectors, pose: LatticePose, owner: number): void;
  remove(model: ModelConnectors, pose: LatticePose, owner: number): void;
  propose(model: ModelConnectors, window: SnapWindow, out: CandidatePoses): void;
  proposeOnLattice(model: ModelConnectors, window: SnapWindow, out: CandidatePoses): void;
  count(model: ModelConnectors, pose: LatticePose): number;
  mates(model: ModelConnectors, pose: LatticePose, out: MateReport): void;
}
