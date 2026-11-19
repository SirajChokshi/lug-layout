import type { ConnectorTable } from "@brr/domain";
import type { Placeable } from "../edit/placeable.ts";

export interface PartWithoutConnectorRecord {
  readonly partIndex: number;
  readonly partId: string;
  readonly reason: string;
}

export interface PlaceableConnectorTables {
  readonly tables: ReadonlyArray<ConnectorTable | null>;
  readonly withoutRecords: ReadonlyArray<PartWithoutConnectorRecord>;
}

export interface IConnectorTables {
  load(placeable: Placeable): Promise<PlaceableConnectorTables>;
  loaded(placeable: Placeable): PlaceableConnectorTables | null;
}
