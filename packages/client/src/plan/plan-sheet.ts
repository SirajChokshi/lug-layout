import type { LduRect, OutlineRing, TableTop } from "@brr/domain";
import type { AisleSide, ObstacleKind } from "@brr/schema/world";
import type { PlanRowSegment } from "./plan-service.ts";

export interface SheetPlacement {
  readonly number: number;
  readonly label: string;
  readonly parts: number;
  readonly segment: PlanRowSegment;
  readonly rings: ReadonlyArray<OutlineRing>;
  readonly flagged: boolean;
}

export interface SheetObstacle {
  readonly name: string;
  readonly rect: LduRect;
  readonly kind: ObstacleKind;
}

export interface SheetAisle {
  readonly name: string;
  readonly rect: LduRect;
  readonly side: AisleSide;
}

export interface SheetPartsList {
  readonly placements: number;
  readonly parts: number;
  readonly lines: number;
  readonly uncounted: number;
}

export interface SheetVerdict {
  readonly buildable: boolean;
  readonly issues: number;
  readonly unmeasured: number;
  readonly notChecked: ReadonlyArray<string>;
  readonly unchecked: string | null;
}

export interface PlanSheet {
  readonly name: string;
  readonly originX: number;
  readonly originZ: number;
  readonly room: LduRect;
  readonly tables: ReadonlyArray<TableTop>;
  readonly obstacles: ReadonlyArray<SheetObstacle>;
  readonly aisles: ReadonlyArray<SheetAisle>;
  readonly roadway: ReadonlyArray<LduRect>;
  readonly ramps: ReadonlyArray<ReadonlyArray<OutlineRing>>;
  readonly placements: ReadonlyArray<SheetPlacement>;
  readonly partsList: SheetPartsList | null;
  readonly verdict: SheetVerdict;
  readonly disclaimer: string;
}
