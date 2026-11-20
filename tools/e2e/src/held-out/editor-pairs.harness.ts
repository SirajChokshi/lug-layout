import { randomInt } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openBundle, type Bundle } from "./bundle.ts";
import {
  cornerModuleCheck,
  EditorPath,
  holesAgainstHolesCheck,
  pairPoses,
  pinnedPairChecks,
  sameOutcomes,
  settledCheck,
  solidEdgeChecks,
  turnedAwayCheck,
  type EditorCheck,
  type Pose,
} from "./editor-pairs.ts";
import {
  blockPools,
  cornerJoinedModule,
  modulePair,
  templateEdges,
  type BlockPools,
  type ModulePair,
  type TemplateEdges,
} from "./generator.ts";
import { startHeadlessEditor } from "./headless-editor.ts";
import { cachingFetch } from "./import-path.ts";
import { solidShiftCollides } from "./pair-scenario.ts";
import { poolCandidates } from "./pool-candidates.ts";
import type { FetchFunction } from "@brr/import";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BUNDLE_ROOT =
  process.env["HELD_OUT_BUNDLE"] ?? join(REPO_ROOT, "tools/asset-pipeline/dist/bundle");
const CACHE_ROOT = join(REPO_ROOT, ".cache/held-out");
const RECORDS_ROOT = join(REPO_ROOT, ".cache/library-bake");
const LIBRARY_CONNECTORS_ROOT = join(REPO_ROOT, "tools/asset-pipeline/dist/library-connectors");
const SEED_RANGE = 2 ** 31;
const DEFAULT_PAIRS = 3;
const MAX_GENERATOR_ATTEMPTS_PER_PAIR = 8;
const PAIR_TIMEOUT_MS = 180_000;
const FULL_SWEEP_TIMEOUT_FACTOR = 4;
const FULL_SWEEP = process.env["HELD_OUT_SWEEP"] === "full";
const MS_PER_SECOND = 1000;
const ORIGIN = 0;
const ASSET_PIPELINE = join(REPO_ROOT, "tools/asset-pipeline");
const PALETTE = join(ASSET_PIPELINE, "palette.json");

interface PaletteModel {
  readonly name: string;
  readonly file: string;
}

interface Template {
  readonly name: string;
  readonly edges: TemplateEdges;
}

interface PairOutcome {
  readonly seed: number;
  readonly label?: string;
  readonly pins: number;
  readonly checks: ReadonlyArray<EditorCheck>;
  readonly seconds: number;
}

function baseSeed(): number {
  const given = process.env["HELD_OUT_SEED"];
  if (given === undefined || given === "") return randomInt(SEED_RANGE);
  const seed = Number(given);
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`HELD_OUT_SEED ${given} is not a seed`);
  return seed;
}

function pairCount(): number {
  const given = process.env["HELD_OUT_EDITOR_PAIRS"];
  if (given === undefined || given === "") return DEFAULT_PAIRS;
  const count = Number(given);
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`HELD_OUT_EDITOR_PAIRS ${given} is not a count`);
  return count;
}

function generatedPairs(pools: BlockPools, seed: number, count: number): ModulePair[] {
  const pairs: ModulePair[] = [];
  for (let next = seed; pairs.length < count; next = (next + 1) % SEED_RANGE) {
    if (next - seed >= count * MAX_GENERATOR_ATTEMPTS_PER_PAIR) {
      throw new Error(
        `the generator built only ${pairs.length} of ${count} pairs from seed ${seed}`,
      );
    }
    try {
      pairs.push(modulePair(pools, next));
    } catch (error) {
      process.stdout.write(
        `seed ${next}: no pair (${error instanceof Error ? error.message : String(error)})\n`,
      );
    }
  }
  return pairs;
}

async function templates(pools: BlockPools): Promise<Template[]> {
  const palette = JSON.parse(await readFile(PALETTE, "utf8")) as {
    readonly models: ReadonlyArray<PaletteModel>;
  };
  const found: Template[] = [];
  for (const model of palette.models) {
    const text = await readFile(join(ASSET_PIPELINE, model.file), "utf8").catch(() => null);
    const edges = text === null ? null : templateEdges(pools, text);
    if (edges) found.push({ name: model.name, edges });
  }
  return found.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function checkCornerModule(
  bundle: Bundle,
  fetchUrl: FetchFunction,
  pools: BlockPools,
  seed: number,
  template: Template,
): Promise<PairOutcome> {
  const started = performance.now();
  const corner = cornerJoinedModule(pools, seed, template.edges);
  const { editor, backend, frame, clock } = await startHeadlessEditor(
    BUNDLE_ROOT,
    bundle,
    fetchUrl,
  );
  const path = new EditorPath(editor, backend, frame, clock);
  const templateItem = editor
    .snapshot()
    .catalog.find((item) => item.id.endsWith(`:${template.name}`))?.id;
  if (templateItem === undefined) throw new Error(`the catalog lists no item for ${template.name}`);
  const templatePose = await placeAtOrigin(path, templateItem);
  const moduleItem = await path.importModel({
    name: corner.module.names.file,
    text: corner.module.text,
  });
  return {
    seed,
    pins: corner.pins,
    label: `corner-joined module beside the palette's ${template.name}`,
    seconds: (performance.now() - started) / MS_PER_SECOND,
    checks: [
      await cornerModuleCheck(
        path,
        templateItem,
        templatePose,
        moduleItem,
        corner.offset,
        corner.pins,
        FULL_SWEEP,
      ),
    ],
  };
}

async function placeAtOrigin(path: EditorPath, item: string): Promise<Pose> {
  await path.hold(item);
  const step = await path.step(ORIGIN, ORIGIN, true);
  if (!step.committed)
    throw new Error(
      `placing ${item} on the empty table was refused: ${step.refusal ?? "no reason"}`,
    );
  return step.committed;
}

function renamedSettleNote(settled: EditorCheck): string {
  return settled.passed
    ? "every renamed hover's pose settled on the first frame"
    : `renamed copy: ${settled.detail}`;
}

async function checkPair(
  bundle: Bundle,
  fetchUrl: FetchFunction,
  pair: ModulePair,
): Promise<PairOutcome> {
  const started = performance.now();
  const { editor, backend, frame, clock } = await startHeadlessEditor(
    BUNDLE_ROOT,
    bundle,
    fetchUrl,
  );
  const path = new EditorPath(editor, backend, frame, clock);
  const subject = await path.importModel({
    name: pair.subject.names.file,
    text: pair.subject.text,
  });
  const partner = await path.importModel({
    name: pair.partner.names.file,
    text: pair.partner.text,
  });
  const holed = await path.importModel({
    name: pair.holedSubject.names.file,
    text: pair.holedSubject.text,
  });
  const renamed = await path.importModel({
    name: pair.renamedSubject.names.file,
    text: pair.renamedSubject.text,
  });

  const subjectPose = await placeAtOrigin(path, subject);
  const poses = pairPoses(path, pair.partnerOffset, pair.alongEdge, subject, subjectPose, partner);
  const pinned = await pinnedPairChecks(path, poses, pair, subject, partner, FULL_SWEEP);
  const turned = await turnedAwayCheck(path, poses, partner, pair.pins);
  path.undoLast();

  const holedPose = await placeAtOrigin(path, holed);
  const holes = await holesAgainstHolesCheck(
    path,
    pairPoses(path, pair.partnerOffset, pair.alongEdge, holed, holedPose, partner),
    partner,
  );
  path.undoLast();

  const renamedPose = await placeAtOrigin(path, renamed);
  const renamedRun = await pinnedPairChecks(
    path,
    pairPoses(path, pair.partnerOffset, pair.alongEdge, renamed, renamedPose, partner),
    pair,
    renamed,
    partner,
    FULL_SWEEP,
  );
  const differences = sameOutcomes(pinned, renamedRun);
  path.undoLast();

  const solid = await path.importModel({
    name: pair.solidPartner.names.file,
    text: pair.solidPartner.text,
  });
  const solidPose = await placeAtOrigin(path, solid);
  const heldOffset: [number, number, number] = [
    0 - pair.partnerOffset[0],
    0 - pair.partnerOffset[1],
    0 - pair.partnerOffset[2],
  ];
  const solidRun = await solidEdgeChecks(
    path,
    pairPoses(path, heldOffset, pair.alongEdge, solid, solidPose, subject),
    pair.solidPartner.assembly,
    pair.subject.assembly,
    solid,
    subject,
    FULL_SWEEP,
    (along) => solidShiftCollides(pair, 0 - along),
  );
  const solidRenamedRun = await solidEdgeChecks(
    path,
    pairPoses(path, heldOffset, pair.alongEdge, solid, solidPose, renamed),
    pair.solidPartner.assembly,
    pair.renamedSubject.assembly,
    solid,
    renamed,
    FULL_SWEEP,
    (along) => solidShiftCollides(pair, 0 - along),
  );
  const solidDifferences = sameOutcomes(solidRun, solidRenamedRun);
  const solidRenamedSettled = settledCheck(solidRenamedRun.steps);
  const renamedSettled = settledCheck(renamedRun.steps);
  const sameSubjectPose = JSON.stringify(subjectPose) === JSON.stringify(renamedPose);

  return {
    seed: pair.seed,
    pins: pair.pins,
    seconds: (performance.now() - started) / MS_PER_SECOND,
    checks: [
      ...pinned.checks,
      holes,
      turned,
      ...solidRun.checks,
      {
        label:
          "Against the solid edge, a renamed copy of the pinned module behaves identically, and every hover's pose settles on the first frame",
        passed: solidDifferences.length === 0 && solidRenamedSettled.passed,
        detail: `${
          solidDifferences.length === 0
            ? "every hover verdict, hit and refusal matches"
            : `differs at: ${solidDifferences.join(", ")}`
        }; ${renamedSettleNote(solidRenamedSettled)}`,
      },
      {
        label:
          "A random rename of the file, model and submodel names behaves identically, and every hover's pose settles on the first frame",
        passed: sameSubjectPose && differences.length === 0 && renamedSettled.passed,
        detail: `${
          sameSubjectPose
            ? differences.length === 0
              ? "every hover verdict, pose, mate count, hit and committed pose matches"
              : `differs at: ${differences.join(", ")}`
            : `the renamed copy lands at a different pose on the empty table`
        }; ${renamedSettleNote(renamedSettled)}`,
      },
    ],
  };
}

function markdown(seed: number, outcomes: ReadonlyArray<PairOutcome>, seconds: number): string {
  const lines = [
    `#### Generated module pairs through the editor's own interface (base seed ${seed}, HELD_OUT_SEED=${seed} reproduces it)`,
    "",
    `${outcomes.length} pairs in ${seconds.toFixed(1)} s, ${FULL_SWEEP ? "full" : "coarse"} sweep (HELD_OUT_SWEEP=full runs every stud offset). Each pair is imported through the import engine in process, then placed and held through \`IEditor\` only: the pinned module is placed and its holed partner is held, in assist (magnetic) and precise modes.`,
    "",
  ];
  for (const outcome of outcomes) {
    const passing = outcome.checks.filter((check) => check.passed).length;
    lines.push(
      `Seed ${outcome.seed}${outcome.label === undefined ? "" : ` (${outcome.label})`}: ${outcome.pins} pins, ${passing} of ${outcome.checks.length} checks pass, ${outcome.seconds.toFixed(1)} s`,
      "",
      "| Check | Result | Detail |",
      "|---|---|---|",
      ...outcome.checks.map(
        (check) =>
          `| ${check.label} | ${check.passed ? "pass" : "**fail**"} | ${check.detail.replaceAll("|", "\\|")} |`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

it(
  "places freshly generated pinned and holed module pairs through the editor's own interface",
  async () => {
    const started = performance.now();
    const seed = baseSeed();
    process.stdout.write(
      `editor-path pairs base seed ${seed} (HELD_OUT_SEED=${seed} reproduces it)\n`,
    );
    const bundle = await openBundle(BUNDLE_ROOT, RECORDS_ROOT, LIBRARY_CONNECTORS_ROOT);
    const fetchUrl = cachingFetch(join(CACHE_ROOT, "ldraw"));
    const pools = blockPools(
      await poolCandidates(bundle, fetchUrl),
      bundle.parts.values(),
      bundle.colors,
    );
    const outcomes: PairOutcome[] = [];
    for (const pair of generatedPairs(pools, seed, pairCount())) {
      outcomes.push(await checkPair(bundle, fetchUrl, pair));
    }
    const found = await templates(pools);
    expect(
      found.length,
      "the palette has a flat square module with Technic hole bricks on an edge",
    ).toBeGreaterThan(0);
    const template = found[seed % found.length];
    if (template) outcomes.push(await checkCornerModule(bundle, fetchUrl, pools, seed, template));
    const report = markdown(seed, outcomes, (performance.now() - started) / MS_PER_SECOND);
    const results = join(CACHE_ROOT, "results");
    await mkdir(results, { recursive: true });
    await writeFile(join(results, `editor-pairs-${seed}.md`), report);
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary) await appendFile(summary, `${report}\n`);
    process.stdout.write(`${report}\n`);
    expect(
      outcomes.flatMap((outcome) =>
        outcome.checks
          .filter((check) => !check.passed)
          .map((check) => `seed ${outcome.seed}: ${check.label} (${check.detail})`),
      ),
      `every check passes for every generated pair; replay with HELD_OUT_SEED=${seed}`,
    ).toEqual([]);
  },
  PAIR_TIMEOUT_MS * (pairCount() + 1) * (FULL_SWEEP ? FULL_SWEEP_TIMEOUT_FACTOR : 1),
);
