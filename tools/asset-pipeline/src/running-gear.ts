import {
  BogieDetector,
  measuredRail,
  ModelConnectors,
  PartRollingTable,
  RunningGearDetector,
  runningGearInput,
  SnapMating,
  SnapShapes,
  WheelsetDetector,
  type ConnectorTable,
  type PartInstances,
  type RunningGear,
} from "@brr/domain";
import { BundleIndexFields, PartShape, SubmodelTree } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { MANIFEST_FILE } from "./publish.ts";

export type ConnectorTableLookup = (
  partId: string,
  shapes: SnapShapes,
) => Promise<ConnectorTable | null>;

const RunningGearManifest = v.pick(BundleIndexFields, ["models", "compiler"]);

const RunningGearModel = v.object({
  parts: v.array(v.string()),
  shapes: v.array(PartShape),
  instances: v.object({ part: v.array(v.number()) }),
  partTransforms: v.array(v.number()),
  submodels: SubmodelTree,
});
type RunningGearModel = v.InferOutput<typeof RunningGearModel>;

function partInstances(model: RunningGearModel): PartInstances {
  const { parent, matrices, ofPart } = model.submodels;
  return {
    count: model.instances.part.length,
    partIndex: Uint32Array.from(model.instances.part),
    matrices: Float64Array.from(model.partTransforms),
    submodels: {
      count: parent.length,
      parent: Int32Array.from(parent),
      matrices: Float64Array.from(matrices),
      ofPart: Int32Array.from(ofPart),
    },
  };
}

function rollingTables(model: RunningGearModel): Array<PartRollingTable | null> {
  return model.shapes.map((shape) =>
    shape.rolling ? PartRollingTable.fromRolling(shape.rolling) : null,
  );
}

function runningGearFields(gear: RunningGear) {
  const { instance, band, reason } = gear.unreadRollingBands;
  return {
    vehicles: gear.vehicles,
    vehicleCouplings: gear.vehicleCouplings,
    unresolvedRunningGear: gear.unresolvedRunningGear,
    unreadRollingBands: {
      instance: Array.from(instance),
      band: Array.from(band),
      reason: Array.from(reason),
    },
  };
}

export async function attachRunningGear(
  directory: string,
  connectorTable: ConnectorTableLookup,
): Promise<void> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const manifest = decodedOrThrow(
    decode(RunningGearManifest, JSON.parse(await readFile(manifestPath, "utf8"))),
    manifestPath,
  );
  const rails = manifest.compiler?.rails ?? [];
  if (rails.length === 0) throw new Error(`${manifestPath}: the compiler names no measured rail`);
  const shapes = new SnapShapes();
  const mating = new SnapMating(shapes);
  const detector = new RunningGearDetector(
    new WheelsetDetector(rails.map((rail) => measuredRail(rail.railHeads))),
    new BogieDetector(mating),
  );
  const tables = new Map<string, Promise<ConnectorTable | null>>();
  const tableOf = (partId: string): Promise<ConnectorTable | null> => {
    let table = tables.get(partId);
    if (table === undefined) {
      table = connectorTable(partId, shapes);
      tables.set(partId, table);
    }
    return table;
  };
  for (const entry of manifest.models) {
    const path = join(directory, entry.file);
    const raw: Record<string, unknown> = JSON.parse(await readFile(path, "utf8"));
    const model = decodedOrThrow(decode(RunningGearModel, raw), entry.file);
    const instances = partInstances(model);
    const connectors = await Promise.all(model.parts.map(tableOf));
    const connected = ModelConnectors.fromParts(connectors, instances, mating);
    const gear = detector.detect(
      runningGearInput(instances, rollingTables(model), connectors, connected, shapes),
    );
    await writeFile(path, JSON.stringify({ ...raw, ...runningGearFields(gear) }));
  }
}
