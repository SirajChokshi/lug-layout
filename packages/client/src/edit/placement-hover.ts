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
  readonly connectors: number;
  readonly joints: number;
  readonly partners: ReadonlyArray<PlacedModelView>;
  readonly inferred: number;
  readonly unverified: number;
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
}

export interface PlacementHover {
  readonly pose: LatticePose;
  readonly accepted: boolean;
  readonly hit: HoverRefusalHit | null;
  readonly mates: ReadonlyArray<HoverMateCount>;
  readonly lifted: boolean;
  readonly turnBlocksSnap: boolean;
}
