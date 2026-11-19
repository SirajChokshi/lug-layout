import { ConnectorRecords } from "@brr/catalog/connector-records";
import {
  BogieDetector,
  ConnectorTable,
  measuredRail,
  ModelConnectors,
  PartRollingTable,
  partExtents,
  RunningGearDetector,
  runningGearInput,
  SnapMating,
  SnapShapes,
  WheelsetDetector,
  type PartInstances,
  type RunningGear,
} from "@brr/domain";
import { BundleIndexFields, PartShape, SubmodelTree } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { MANIFEST_FILE } from "./publish.ts";

const RunningGearManifest = v.pick(BundleIndexFields, [
  "models",
  "compiler",
  "connectors",
  "connectivity",
]);

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

export async function attachRunningGear(directory: string): Promise<void> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const manifest = decodedOrThrow(
    decode(RunningGearManifest, JSON.parse(await readFile(manifestPath, "utf8"))),
    manifestPath,
  );
  const { compiler } = manifest;
  if (!compiler || compiler.rails.length === 0) {
    throw new Error(`${manifestPath}: the compiler names no measured rail`);
  }
  const records = new ConnectorRecords(
    async (path) => JSON.parse(await readFile(join(directory, path), "utf8")),
    { connectivity: manifest.connectivity.file, connectors: manifest.connectors.file },
    compiler.sectionVocabulary.sha256,
  );
  const shapes = new SnapShapes();
  const mating = new SnapMating(shapes);
  const detector = new RunningGearDetector(
    new WheelsetDetector(compiler.rails.map((rail) => measuredRail(rail.railHeads))),
    new BogieDetector(mating),
  );
  const tables = new Map<string, Promise<ConnectorTable | null>>();
  const tableOf = (partId: string): Promise<ConnectorTable | null> => {
    let table = tables.get(partId);
    if (table === undefined) {
      table = records
        .load(partId)
        .then((columns) =>
          columns === null ? null : ConnectorTable.fromColumns(columns, shapes, partId),
        );
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
      runningGearInput(
        instances,
        rollingTables(model),
        model.shapes.map((shape) => partExtents(shape.extents)),
        connectors,
        connected,
        shapes,
      ),
    );
    await writeFile(path, JSON.stringify({ ...raw, ...runningGearFields(gear) }));
  }
}
