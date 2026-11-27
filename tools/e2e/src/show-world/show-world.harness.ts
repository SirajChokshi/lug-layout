import { TRACK_ITEM_ID, type CatalogItemView, type RoadKitView } from "@brr/client";
import { STUD_LDU } from "@brr/math";
import { randomInt } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openBundle } from "../held-out/bundle.ts";
import { EditorPath } from "../held-out/editor-pairs.ts";
import { blockPools, SeededRandom, showModule } from "../held-out/generator.ts";
import { startHeadlessEditor } from "../held-out/headless-editor.ts";
import { cachingFetch } from "../held-out/import-path.ts";
import { poolCandidates } from "../held-out/pool-candidates.ts";
import { SHOW_SCALES, ShowLayout, type ShowSpec, type TrackKit } from "./show-layout.ts";
import { ShowWorldBuilder, type ShowWorld } from "./show-world-builder.ts";
import { TrackLayer } from "./track-layer.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BUNDLE_ROOT =
  process.env["HELD_OUT_BUNDLE"] ?? join(REPO_ROOT, "tools/asset-pipeline/dist/bundle");
const RECORDS_ROOT = join(REPO_ROOT, ".cache/library-bake");
const LIBRARY_CONNECTORS_ROOT = join(REPO_ROOT, "tools/asset-pipeline/dist/library-connectors");
const CACHE_ROOT = join(REPO_ROOT, ".cache/held-out");
const OUT_ROOT = process.env["SHOW_WORLD_OUT"] ?? join(REPO_ROOT, ".cache/show-world");
const SEED_RANGE = 2 ** 31;
const PROBE_CLEARANCE_CELLS = 8;
const MINUTE_MS = 60_000;
const MINUTES_PER_MODEL = 0.5;
const BASE_MINUTES = 10;
const MS_PER_SECOND = 1000;

function seedOf(): number {
  const given = process.env["SHOW_WORLD_SEED"];
  if (given === undefined || given === "") return randomInt(SEED_RANGE);
  const seed = Number(given);
  if (!Number.isInteger(seed) || seed < 0)
    throw new Error(`SHOW_WORLD_SEED ${given} is not a seed`);
  return seed;
}

function roadKit(kits: ReadonlyArray<RoadKitView>, spec: ShowSpec): RoadKitView {
  const kit = kits.find(
    (candidate) =>
      spec.tableWidthStuds % candidate.tileStuds === 0 &&
      spec.tableDepthStuds % candidate.tileStuds === 0,
  );
  if (!kit) throw new Error("the editor offers no road kit whose tiles divide the tables");
  return kit;
}

function baseplateFor(catalog: ReadonlyArray<CatalogItemView>, cellStuds: number): CatalogItemView {
  const square = catalog.filter(
    (item) =>
      item.kind === "baseplate" && item.studsWide === cellStuds && item.studsDeep === cellStuds,
  );
  const chosen = square.find((item) => item.displayColor) ?? square[0];
  if (!chosen) throw new Error(`the catalog has no ${cellStuds} × ${cellStuds} baseplate`);
  return chosen;
}

function report(
  spec: ShowSpec,
  seed: number,
  kit: TrackKit,
  world: ShowWorld,
  seconds: number,
): string {
  const { counts } = world;
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ["Tables", String(spec.tableRows * spec.tablesPerRow), String(counts.tables)],
    ["Baseplates", "the cells left over", String(counts.baseplates)],
    ["Road plates", String(spec.roadPlates), String(counts.roadPlates)],
    ["Track pieces", `about ${spec.trackPieces}`, String(counts.trackPieces)],
    ["Switches", String(2 * spec.sidingsPerOval * spec.tableRows), String(counts.switches)],
    ["Open track ends", "0", String(counts.openTrackEnds)],
    ["Unsupported track pieces", "0", String(counts.unsupportedTrack)],
    ["Imported custom models", String(spec.models), String(counts.models)],
    ["Parts in those models", `about ${spec.models * 1500}`, String(counts.modelParts)],
    ["Contributors (model authors)", String(spec.contributors), String(counts.authors)],
    ["Placements", "", String(counts.placements)],
    ["Parts in the world", "", String(counts.parts)],
  ];
  return [
    `#### Show-scale world, ${scale} scale, seed ${seed} (SHOW_WORLD_SEED=${seed} SHOW_WORLD_SCALE=${scale} reproduces it)`,
    "",
    `Built through \`IEditor\` in ${seconds.toFixed(0)} s. Track kit measured through the editor: a straight is ${kit.straightLdu} LDU, ${kit.curvesPerHalfTurn} curves turn it around ${Math.abs(kit.halfTurnOffsetLdu)} LDU over. ${world.refusedModelCells} model cells were refused by the editor and left to baseplates; ${world.unplacedModels} models found no cell.`,
    "",
    "| | Asked | Built |",
    "|---|---:|---:|",
    ...rows.map(([label, asked, built]) => `| ${label} | ${asked} | ${built} |`),
    "",
    "| Phase | Seconds |",
    "|---|---:|",
    ...world.phases.map((phase) => `| ${phase.phase} | ${phase.seconds.toFixed(1)} |`),
    "",
  ].join("\n");
}

const scale = process.env["SHOW_WORLD_SCALE"] ?? "smoke";
const spec = SHOW_SCALES[scale];
if (!spec)
  throw new Error(`SHOW_WORLD_SCALE ${scale} isn't one of ${Object.keys(SHOW_SCALES).join(", ")}`);

it(
  `builds the ${scale}-scale show world through the editor's own interface`,
  async () => {
    const started = performance.now();
    const seed = seedOf();
    process.stdout.write(`show world ${scale} seed ${seed} (SHOW_WORLD_SEED=${seed})\n`);
    const bundle = await openBundle(BUNDLE_ROOT, RECORDS_ROOT, LIBRARY_CONNECTORS_ROOT);
    const fetchUrl = cachingFetch(join(CACHE_ROOT, "ldraw"));
    const pools = blockPools(
      await poolCandidates(bundle, fetchUrl),
      bundle.parts.values(),
      bundle.colors,
    );
    const { editor, backend, frame, clock, plans } = await startHeadlessEditor(
      BUNDLE_ROOT,
      bundle,
      fetchUrl,
    );
    await editor.newWorld(`Show world ${scale} ${seed}`);
    const path = new EditorPath(editor, backend, frame, clock);
    const { catalog, roadKits } = editor.snapshot();
    const road = roadKit(roadKits, spec);
    const baseplate = baseplateFor(catalog, road.tileStuds);
    const cellLdu = road.tileStuds * STUD_LDU;
    const track = new TrackLayer(path, TRACK_ITEM_ID);
    const kit = await track.probe({ x: 0, z: -PROBE_CLEARANCE_CELLS * cellLdu });
    const layout = new ShowLayout(spec, cellLdu, kit, seed);
    const random = new SeededRandom(seed);
    const authors = layout.contributors();
    const models = Array.from({ length: spec.models }, (_, index) =>
      showModule(pools, random.int(SEED_RANGE), authors[index % authors.length] ?? ""),
    );
    const world = await new ShowWorldBuilder(
      path,
      layout,
      track,
      kit,
      { baseplate: baseplate.id, roadKit: road.id, track: TRACK_ITEM_ID },
      plans,
    ).build(models);
    const stem = `show-world-${scale}-${seed}`;
    await mkdir(OUT_ROOT, { recursive: true });
    await writeFile(join(OUT_ROOT, `${stem}.brr.zip`), world.world);
    await writeFile(join(OUT_ROOT, `${stem}.brrplan.zip`), world.plan);
    await writeFile(
      join(OUT_ROOT, `${stem}.edits.json`),
      `${JSON.stringify(world.edits, null, 2)}\n`,
    );
    const text = report(spec, seed, kit, world, (performance.now() - started) / MS_PER_SECOND);
    await writeFile(join(OUT_ROOT, `${stem}.md`), text);
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary) await appendFile(summary, `${text}\n`);
    process.stdout.write(`${text}\n`);

    const reopened = await startHeadlessEditor(BUNDLE_ROOT, bundle, fetchUrl);
    expect(await reopened.editor.importWorld(world.world), "the exported world opens again").toBe(
      true,
    );
    const { counts } = world;
    expect({
      tables: counts.tables,
      models: counts.models,
      roadPlates: counts.roadPlates,
      switches: counts.switches,
      openTrackEnds: counts.openTrackEnds,
      unsupportedTrack: counts.unsupportedTrack,
      authors: counts.authors,
      unplacedModels: world.unplacedModels,
      reopenedPlacements: reopened.editor.snapshot().placements,
      reopenedTrack: reopened.editor.snapshot().track?.pieces ?? 0,
    }).toEqual({
      tables: spec.tableRows * spec.tablesPerRow,
      models: spec.models,
      roadPlates: spec.roadPlates,
      switches: 2 * spec.sidingsPerOval * spec.tableRows,
      openTrackEnds: 0,
      unsupportedTrack: 0,
      authors: Math.min(spec.contributors, spec.models),
      unplacedModels: 0,
      reopenedPlacements: counts.placements,
      reopenedTrack: counts.trackPieces,
    });
  },
  (BASE_MINUTES + spec.models * MINUTES_PER_MODEL) * MINUTE_MS,
);
