import type { CandidatePoses, LatticePose, SnapWindow } from "./candidate-poses.ts";
import type { MateReport } from "./mate-report.ts";
import type { ModelConnectors } from "./model-connectors.ts";
import type { ProposalProgress } from "./proposal-progress.ts";

interface CommonMateFinder {
  readonly proposesEveryPose: boolean;
  insert(model: ModelConnectors, pose: LatticePose, owner: number): void;
  remove(model: ModelConnectors, pose: LatticePose, owner: number): void;
  placedChanged(): void;
  propose(model: ModelConnectors, window: SnapWindow, out: CandidatePoses): void;
  proposeOnLattice(
    model: ModelConnectors,
    window: SnapWindow,
    out: CandidatePoses,
    progress: ProposalProgress,
    slotBudget: number,
  ): boolean;
  count(model: ModelConnectors, pose: LatticePose): number;
  mates(model: ModelConnectors, pose: LatticePose, out: MateReport): void;
}

export interface PartnerNamingFinder extends CommonMateFinder {
  readonly namesPartners: true;
  joinsPart(
    model: ModelConnectors,
    pose: LatticePose,
    instance: number,
    partner: number,
    partnerInstance: number,
  ): boolean;
}

export interface UnnamedPartnerFinder extends CommonMateFinder {
  readonly namesPartners: false;
}

export type MateFinder = PartnerNamingFinder | UnnamedPartnerFinder;
