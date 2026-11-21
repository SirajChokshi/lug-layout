import type { LatticePose } from "@brr/domain";

export type ConnectorGender = "male" | "female";

export type SectionProfile = "round" | "axle" | "square" | "flare" | "finger";

export interface ConnectorSectionView {
  readonly profile: SectionProfile;
  readonly sizeLdu: number;
  readonly lengthLdu: number;
}

export interface ConnectorKindView {
  readonly gender: ConnectorGender;
  readonly slides: boolean;
  readonly sections: ReadonlyArray<ConnectorSectionView>;
}

export interface PlacedModelView {
  readonly item: string;
  readonly label: string;
  readonly pose: LatticePose;
}

export interface HoverMateCount {
  readonly kind: ConnectorKindView;
  readonly partnerKinds: ReadonlyArray<ConnectorKindView>;
  readonly connectors: number;
  readonly joints: number;
  readonly jointIds: ReadonlySet<number>;
  readonly partners: ReadonlyArray<PlacedModelView>;
  readonly inferred: number;
  readonly unverified: number;
}

export interface HoverWait {
  readonly placed: PlacedModelView;
  readonly failed: boolean;
}

export interface HoverRefusalHit {
  readonly placed: PlacedModelView;
  readonly part: string | null;
  readonly partLabel: string | null;
  readonly cellX: number;
  readonly cellZ: number;
  readonly placedBottomLdu: number;
  readonly placedTopLdu: number;
  readonly heldBottomLdu: number;
  readonly heldTopLdu: number;
  readonly byColumnOnly: boolean;
}

export type PlacementMode = "assist" | "precise";

export interface MagnetOffset {
  readonly dxLdu: number;
  readonly dzLdu: number;
  readonly dyPlates: number;
  readonly distanceLdu: number;
}

export interface AssistNeighbourhood {
  readonly ldu: number;
  readonly cells: number;
  readonly plates: number;
}

export interface PlacementHover {
  readonly pose: LatticePose;
  readonly accepted: boolean;
  readonly hit: HoverRefusalHit | null;
  readonly mates: ReadonlyArray<HoverMateCount>;
  readonly joints: number;
  readonly lifted: boolean;
  readonly restsOn: ReadonlyArray<PlacedModelView>;
  readonly turnBlocksSnap: boolean;
  readonly turnMates: ReadonlyArray<HoverMateCount>;
  readonly turnJoints: number;
  readonly mode: PlacementMode;
  readonly magnetised: boolean;
  readonly magnet: MagnetOffset;
  readonly assistNeighbourhood: AssistNeighbourhood;
  readonly settled: boolean;
  readonly turnSettled: boolean;
  readonly waitingOn: HoverWait | null;
}

export function distinctJoints(
  mates: ReadonlyArray<{ readonly jointIds: Iterable<number> }>,
): number {
  const seen = new Set<number>();
  for (const mate of mates) {
    for (const joint of mate.jointIds) seen.add(joint);
  }
  return seen.size;
}
