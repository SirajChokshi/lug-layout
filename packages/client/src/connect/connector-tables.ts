import { ConnectorTable, type SnapShapes } from "@brr/domain";
import { inject, injectable } from "inversify";
import type { IPlaceableCatalog, PartConnectorRecord } from "../catalog/placeable-catalog.ts";
import type { Placeable } from "../edit/placeable.ts";
import { errorText } from "../edit/error-text.ts";
import { PLACEABLE_CATALOG, SNAP_SHAPES } from "../tokens.ts";

export interface PartWithoutConnectorRecord {
  readonly partIndex: number;
  readonly partId: string;
  readonly reason: string;
}

export interface PlaceableConnectorTables {
  readonly tables: ReadonlyArray<ConnectorTable | null>;
  readonly withoutRecords: ReadonlyArray<PartWithoutConnectorRecord>;
}

export type ConnectedPlaceable = Pick<Placeable, "id" | "partTransforms">;

export type ConnectorRecordSource = Pick<IPlaceableCatalog, "partConnectorRecord"> & {
  parts(): ReadonlyArray<{ readonly id: string }>;
};

export interface IConnectorTables {
  load(placeable: ConnectedPlaceable): Promise<PlaceableConnectorTables>;
  loaded(placeable: ConnectedPlaceable): PlaceableConnectorTables | null;
}

type PartTable =
  | { readonly kind: "table"; readonly table: ConnectorTable }
  | { readonly kind: "missing"; readonly reason: string };

function usedPartIndices(placeable: ConnectedPlaceable): ReadonlyArray<number> {
  const { count, partIndex } = placeable.partTransforms;
  const used = new Set<number>();
  for (let i = 0; i < count; i++) used.add(partIndex[i] ?? 0);
  return [...used].toSorted((a, b) => a - b);
}

@injectable()
export class ConnectorTables implements IConnectorTables {
  private readonly loading = new Map<string, Promise<PlaceableConnectorTables>>();
  private readonly ready = new Map<string, PlaceableConnectorTables>();
  private readonly partTables = new Map<string, Promise<PartTable>>();

  constructor(
    @inject(PLACEABLE_CATALOG) private readonly catalog: ConnectorRecordSource,
    @inject(SNAP_SHAPES) private readonly shapes: SnapShapes,
  ) {}

  load(placeable: ConnectedPlaceable): Promise<PlaceableConnectorTables> {
    const ready = this.ready.get(placeable.id);
    if (ready) return Promise.resolve(ready);
    let loading = this.loading.get(placeable.id);
    if (!loading) {
      loading = this.build(placeable);
      this.loading.set(placeable.id, loading);
      loading.then(
        (built) => {
          this.ready.set(placeable.id, built);
          this.loading.delete(placeable.id);
        },
        () => this.loading.delete(placeable.id),
      );
    }
    return loading;
  }

  loaded(placeable: ConnectedPlaceable): PlaceableConnectorTables | null {
    return this.ready.get(placeable.id) ?? null;
  }

  private async build(placeable: ConnectedPlaceable): Promise<PlaceableConnectorTables> {
    const used = usedPartIndices(placeable);
    const parts = this.catalog.parts();
    const tables = Array.from<unknown, ConnectorTable | null>(
      { length: (used.at(-1) ?? -1) + 1 },
      () => null,
    );
    const withoutRecords: PartWithoutConnectorRecord[] = [];
    const outcomes = await Promise.all(
      used.map((partIndex) => {
        const part = parts[partIndex];
        if (!part)
          throw new Error(`${placeable.id} uses part index ${partIndex}, outside the catalog`);
        return this.partTable(partIndex, part.id).then((outcome) => ({ partIndex, part, outcome }));
      }),
    );
    for (const { partIndex, part, outcome } of outcomes) {
      if (outcome.kind === "table") tables[partIndex] = outcome.table;
      else withoutRecords.push({ partIndex, partId: part.id, reason: outcome.reason });
    }
    return { tables, withoutRecords };
  }

  private partTable(partIndex: number, partId: string): Promise<PartTable> {
    const cached = this.partTables.get(partId);
    if (cached) return cached;
    const loading = this.catalog
      .partConnectorRecord(partIndex)
      .then((record) => this.tableOf(record, partId));
    this.partTables.set(partId, loading);
    loading.then(
      (outcome) => {
        if (outcome.kind === "missing") this.partTables.delete(partId);
      },
      () => this.partTables.delete(partId),
    );
    return loading;
  }

  private tableOf(record: PartConnectorRecord, partId: string): PartTable {
    switch (record.kind) {
      case "record":
        try {
          return {
            kind: "table",
            table: ConnectorTable.fromColumns(record.connectors, this.shapes, partId),
          };
        } catch (error) {
          return {
            kind: "missing",
            reason: `its connector record is malformed: ${errorText(error)}`,
          };
        }
      case "missing":
        return { kind: "missing", reason: record.reason };
      default: {
        const unhandled: never = record;
        throw new Error(`unhandled connector record ${String(unhandled)}`);
      }
    }
  }
}
