import { connectorRecordIssues } from "@brr/catalog/connector-license";
import {
  partConnectors,
  type ConnectorLoad,
  type PartConnectors,
} from "@brr/catalog/connector-records";
import type {
  BakedModel,
  BakeOutcome,
  BakeInputs,
  BakePhases,
  BakeRequest,
  BrickCompiler,
  CompileLod,
  Failure,
  FailureKind,
  InlineOutcome,
  InlinePart,
  LdrawHeader,
  LibraryFiles,
  LooseGeometry,
  ModelRead,
  PartOutcome,
  PlacementBakeRequest,
  RecordFiles,
  VisibilityBakeRequest,
} from "./brick-compiler.ts";
import {
  customClosure,
  mpdSections,
  normalizeReference,
  renameReferences,
  withoutReservedPaths,
  type CustomClosure,
  type CustomCycle,
  type CustomSource,
} from "./custom-parts.ts";
import { isDirectColor } from "@brr/catalog/colors";
import { parseGlb } from "@brr/catalog/glb";
import {
  CONNECTIVITY_LICENSE,
  CONNECTOR_SOURCE,
  CONNECTOR_STATUS,
  submodelTreeFits,
  type CompilerVehicles,
  type InferredConnectorRecords,
  type LibraryBakePart,
  type MalformedFinding,
  type PrimitiveConnectorTable,
  type SectionVocabulary,
  type ShadowPatchManifest,
} from "@brr/schema/bundle";
import { MODEL_ROOT, type SubmodelInstances } from "@brr/domain";
import type { IPartRecords } from "./library-bake-store.ts";
import type { LdrawMirror, MirrorSource, MirrorStats, Probe } from "./ldraw-mirror.ts";
import type { CachedGlyph, PlanGlyphCache } from "./plan-glyph-cache.ts";
import { isShadowLibraryPath, type IShadowLibrary } from "./shadow-mirror.ts";
import type { StudioReport } from "./studio-import.ts";
import { TimeSpent } from "./time-spent.ts";
import { bakeReceptors, type BakeReceptors } from "./bake-receptors.ts";
import type { RecordStats } from "./verified-files.ts";

export interface ImportJob {
  readonly fileName: string;
  readonly text: string;
  readonly lod: CompileLod;
  readonly source: MirrorSource;
  readonly studPrimitives: ReadonlyArray<string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly primitives: PrimitiveConnectorTable | null;
  readonly sectionVocabulary: SectionVocabulary;
  readonly cavityProbe: string;
  readonly bundlePartIds: ReadonlyArray<string>;
  readonly ldconfigCodes: ReadonlyArray<number>;
  readonly translucentColors: ReadonlyArray<number>;
  readonly tableDepthLdu: number;
  readonly vehicles: CompilerVehicles | null;
}

interface Counted {
  readonly reference: string;
  readonly official: string;
  readonly instances: number;
}

export type CustomOrigin = "mpd" | "inlineDiffers" | "studio";

export interface InlineDifference {
  readonly colorsMatch: boolean;
  readonly inlineColors: ReadonlyArray<number>;
  readonly officialColors: ReadonlyArray<number>;
  readonly maxMeasuredDistanceLdu: number;
  readonly surfaceWithinWeld: boolean;
  readonly weldEpsilonLdu: number;
}

export type ConnectorSourceName = keyof typeof CONNECTOR_SOURCE;

export interface CustomConnectorCounts {
  readonly total: number;
  readonly bySource: Readonly<Record<ConnectorSourceName, number>>;
  readonly unverified: number;
}

export type PartResolution =
  | (Counted & { readonly kind: "bundle"; readonly partId: string })
  | (Counted & {
      readonly kind: "custom";
      readonly partId: string;
      readonly origin: CustomOrigin;
      readonly file: string;
      readonly header: LdrawHeader;
      readonly sourceFiles: number;
      readonly connectors: CustomConnectorCounts | null;
      readonly difference: InlineDifference | null;
    })
  | (Counted & {
      readonly kind: "customRefused";
      readonly origin: CustomOrigin;
      readonly gate: FailureKind;
      readonly path: string;
      readonly message: string;
      readonly difference: InlineDifference | null;
    })
  | (Counted & {
      readonly kind: "compiled";
      readonly partId: string;
      readonly file: string;
      readonly header: LdrawHeader;
      readonly sourceFiles: number;
    })
  | (Counted & { readonly kind: "notInLibrary"; readonly definedInline: boolean })
  | (Counted & { readonly kind: "missingSubfile"; readonly missing: string; readonly from: string })
  | (Counted & {
      readonly kind: "rejected";
      readonly gate: "unofficial";
      readonly path: string;
      readonly message: string;
    })
  | (Counted & InlineDifference & { readonly kind: "inlineDiffers" })
  | (Counted & {
      readonly kind: "malformed";
      readonly findings: ReadonlyArray<MalformedFinding>;
      readonly message: string;
    })
  | (Counted & {
      readonly kind: "tooLarge";
      readonly cause: "beyondAddressSpace" | "memoryUnavailable";
      readonly message: string;
    })
  | (Counted & { readonly kind: "failed"; readonly message: string });

export interface ColorIssue {
  readonly code: number;
  readonly instances: number;
}

export interface ImportTimings {
  readonly readMs: number;
  readonly resolveMs: number;
  readonly bakeMs: number;
  readonly totalMs: number;
  readonly placementMs: number;
  readonly recordFetchMs: number;
  readonly compileMs: number;
  readonly ldrawFetchMs: number;
  readonly shadowFetchMs: number;
  readonly bakePhases: BakePhases | null;
  readonly coverPhases: BakePhases | null;
}

export interface ImportReport {
  readonly fileName: string;
  readonly mirror: MirrorSource;
  readonly lod: CompileLod;
  readonly sections: ReadonlyArray<LdrawHeader>;
  readonly instanceCount: number;
  readonly drawnInstanceCount: number;
  readonly parts: ReadonlyArray<PartResolution>;
  readonly inlineParts: ReadonlyArray<InlinePart>;
  readonly looseGeometry: ReadonlyArray<LooseGeometry>;
  readonly unknownColors: ReadonlyArray<ColorIssue>;
  readonly directColors: ReadonlyArray<number>;
  readonly compileRounds: number;
  readonly withoutConnectorRecords: ReadonlyArray<string>;
  readonly refusedConnectorRecords: ReadonlyArray<RefusedConnectorRecord>;
  readonly bakeRounds: number;
  readonly bakeIssue: string | null;
  readonly bakeHelpersFailed: number;
  readonly glyphFromCache: boolean;
  readonly fetched: MirrorStats;
  readonly records: RecordReport | null;
  readonly shadowLibrary: RecordStats | null;
  readonly timings: ImportTimings;
}

export interface RecordReport {
  readonly pinnedParts: number;
  readonly bakedFromRecords: number;
  readonly fetched: number;
  readonly cached: number;
  readonly bytes: number;
}

export interface ImportedSubmodels extends SubmodelInstances {
  readonly parent: Int32Array;
  readonly ofPart: Int32Array;
}

export type CompiledSource = "library-bake" | "import";

export interface CompiledGlb {
  readonly partId: string;
  readonly glb: Uint8Array;
  readonly source: CompiledSource;
}

export type ModelBake = Omit<BakedModel, "status" | "recordedParts" | "resumedParts" | "phases">;

export type PlacementBake = Omit<ModelBake, "studCover" | "glyph" | "glyphIssue">;

export interface PlacedImport extends Omit<ImportResult, "bake" | "report" | "studio"> {
  readonly sections: ReadonlyArray<LdrawHeader>;
  readonly refusedConnectorRecords: ReadonlyArray<RefusedConnectorRecord>;
  readonly bake: PlacementBake;
}

export type PlacementListener = (placed: PlacedImport) => void;

export const IGNORE_PLACEMENT: PlacementListener = () => undefined;

export interface IBakeHelper {
  bake(
    request: BakeRequest,
    library: LibraryFiles,
    records: RecordFiles | null,
  ): Promise<BakeOutcome>;
}

export interface ImportResult {
  readonly report: ImportReport;
  readonly partIds: ReadonlyArray<string>;
  readonly instanceCount: number;
  readonly partIndex: Uint32Array;
  readonly ldrawColor: Uint32Array;
  readonly matrices: Float32Array;
  readonly partTransforms: Float64Array;
  readonly submodels: ImportedSubmodels;
  readonly compiled: ReadonlyArray<CompiledGlb>;
  readonly connectors: ReadonlyArray<PartConnectors | null>;
  readonly bake: ModelBake | null;
  readonly studio?: StudioReport;
}

export interface PartConnectorSource {
  read(partId: string): Promise<ConnectorLoad>;
}

export interface RefusedConnectorRecord {
  readonly partId: string;
  readonly reason: string;
}

const MAX_COMPILE_ROUNDS = 64;

function refusedRecords(
  partIds: ReadonlyArray<string>,
  loads: ReadonlyArray<ConnectorLoad>,
): ReadonlyArray<RefusedConnectorRecord> {
  return partIds.flatMap((partId, index) => {
    const load = loads[index];
    return load?.kind === "refused" ? [{ partId, reason: load.reason }] : [];
  });
}

function loadedConnectors(loads: ReadonlyArray<ConnectorLoad>): Array<PartConnectors | null> {
  return loads.map((load) => (load.kind === "loaded" ? load.connectors : null));
}
const NOTHING_INFERRED: ReadonlyArray<string> = [];
const RESOLVER_DIRECTORIES: ReadonlyArray<string> = ["p/8/", "parts/", "p/"];
const NOTHING_PROBED: Probe = { found: new Map(), absent: [] };
const RECORDED_LOD: CompileLod = "standard";
const PRIMARY_SLICES = 1;
const HELPER_SLICES = 2;
const HELPER_DEADLINE_PER_PRIMARY_MS = 4;
const HELPER_DEADLINE_SLACK_MS = 5_000;
const FETCH_CONCURRENCY = 16;
const MATRIX_FLOATS = 12;
const UNCACHED_GLYPH: CachedGlyph = { glyph: null, keep: async () => undefined };

function bitCount(word: number): number {
  let bits = word - ((word >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const settle = (value: T | null): void => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(settle, () => settle(null));
  });
}

function asksForHeldFiles(outcome: BakeOutcome, library: ImportLibrary): boolean {
  return (
    outcome.status === "need" &&
    outcome.paths.every((path) => library.files.has(path) || library.absent.has(path))
  );
}

function joinedShards(
  primary: BakedModel,
  others: ReadonlyArray<BakedModel>,
): Omit<ModelBake, "glyph" | "glyphIssue"> {
  const {
    status: _baked,
    recordedParts: _recorded,
    resumedParts: _resumed,
    phases: _phases,
    glyph: _glyph,
    glyphIssue: _glyphIssue,
    ...bake
  } = primary;
  const { studs } = primary.studCover;
  const visibleBits = primary.studCover.visibleBits.slice();
  for (const other of others) {
    const bits = other.studCover.visibleBits;
    if (other.studCover.studs !== studs || bits.length !== visibleBits.length) {
      throw new Error(`a bake shard covers ${other.studCover.studs} studs, not ${studs}`);
    }
    for (let word = 0; word < visibleBits.length; word++) {
      visibleBits[word] = (visibleBits[word] ?? 0) & (bits[word] ?? 0);
    }
  }
  let visible = 0;
  for (let word = 0; word < visibleBits.length; word++) visible += bitCount(visibleBits[word] ?? 0);
  return {
    ...bake,
    studCover: { studs, covered: studs - visible, visibleBits },
  };
}

function placementBake(baked: BakedModel): PlacementBake {
  return {
    lattice: baked.lattice,
    latticeIssue: baked.latticeIssue,
    cells: baked.cells,
    vehicles: baked.vehicles,
    vehicleIssue: baked.vehicleIssue,
  };
}

export function bundlePartId(reference: string): string {
  return `ldraw:${reference.replace(/(\.dat)+$/u, "").replaceAll("/", "-")}`;
}

interface Outcomes {
  readonly parts: Map<string, Exclude<PartOutcome, { status: "need" }>>;
  readonly inline: Map<string, Exclude<InlineOutcome, { status: "need" }>>;
  readonly rounds: number;
  readonly weldEpsilonLdu: number;
  readonly fromLibraryBake: ReadonlySet<string>;
}

interface ImportLibrary extends LibraryFiles {
  readonly files: Map<string, string>;
  readonly absent: Set<string>;
}

interface Assembled {
  readonly result: Omit<ImportResult, "bake" | "report" | "connectors"> & {
    readonly report: Omit<
      ImportReport,
      | "bakeRounds"
      | "bakeIssue"
      | "bakeHelpersFailed"
      | "glyphFromCache"
      | "fetched"
      | "records"
      | "shadowLibrary"
      | "timings"
      | "withoutConnectorRecords"
      | "refusedConnectorRecords"
    >;
  };
  readonly drawn: Uint8Array;
}

interface DrawnInstances {
  readonly mask: Uint8Array;
  readonly receptors: Promise<BakeReceptors>;
}

interface BakeRounds {
  readonly bake: ModelBake | null;
  readonly issue: string | null;
  readonly rounds: number;
  readonly helpersFailed: number;
  readonly glyphFromCache: boolean;
  readonly recordedParts: number;
  readonly phases: BakePhases | null;
  readonly coverPhases: BakePhases | null;
  readonly placedAt: number | null;
}

interface CustomCandidate {
  readonly index: number;
  readonly origin: CustomOrigin;
  readonly closure: CustomClosure;
}

interface CustomCompiled {
  readonly glb: Uint8Array;
  readonly connectors: ConnectorLoad;
}

interface CustomPass {
  readonly parts: ReadonlyArray<PartResolution>;
  readonly compiled: ReadonlyMap<string, CustomCompiled>;
  readonly bakeSource: string;
  readonly ownFiles: ReadonlyMap<string, string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly rounds: number;
}

interface ClosureRequest {
  readonly parts: ReadonlyArray<string>;
  readonly inlineChecks: ReadonlyArray<InlinePart>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly infer: ReadonlyArray<string>;
  readonly shadowPatchManifest: ShadowPatchManifest | null;
}

interface CompiledClosure {
  readonly parts: Map<string, Exclude<PartOutcome, { status: "need" }>>;
  readonly inline: Map<string, Exclude<InlineOutcome, { status: "need" }>>;
  readonly rounds: number;
  readonly weldEpsilonLdu: number;
}

type ConnectorInference =
  | { readonly kind: "inferred"; readonly manifest: ShadowPatchManifest }
  | { readonly kind: "notInferred"; readonly load: ConnectorLoad };

const NOT_INFERRED: ConnectorInference = { kind: "notInferred", load: { kind: "unlisted" } };

function customOrigin(
  part: PartResolution,
  studioFiles: ReadonlyMap<string, string>,
): CustomOrigin | null {
  if (studioFiles.has(normalizeReference(part.reference))) return "studio";
  if (part.kind === "inlineDiffers") return "inlineDiffers";
  return part.kind === "notInLibrary" && part.definedInline ? "mpd" : null;
}

function cyclicRefusal(
  part: PartResolution,
  origin: CustomOrigin,
  cycle: CustomCycle,
): PartResolution {
  return {
    kind: "customRefused",
    reference: part.reference,
    official: part.official,
    instances: part.instances,
    origin,
    gate: "tooDeep",
    path: cycle.through[0] ?? cycle.reference,
    message: `its own sub-files refer to each other in a loop: ${cycle.through.join(", ")}`,
    difference: inlineDifference(part),
  };
}

function inlineDifference(part: PartResolution): InlineDifference | null {
  if (part.kind !== "inlineDiffers") return null;
  const {
    colorsMatch,
    inlineColors,
    officialColors,
    maxMeasuredDistanceLdu,
    surfaceWithinWeld,
    weldEpsilonLdu,
  } = part;
  return {
    colorsMatch,
    inlineColors,
    officialColors,
    maxMeasuredDistanceLdu,
    surfaceWithinWeld,
    weldEpsilonLdu,
  };
}

function connectorCounts(load: ConnectorLoad): CustomConnectorCounts | null {
  if (load.kind !== "loaded") return null;
  const { connectors } = load;
  const faces = new Map<number, number>();
  let unverified = 0;
  for (let face = 0; face < connectors.count; face++) {
    const source = connectors.source[face] ?? 0;
    faces.set(source, (faces.get(source) ?? 0) + 1);
    if (connectors.status[face] === CONNECTOR_STATUS.unverified) unverified++;
  }
  const of = (source: number): number => faces.get(source) ?? 0;
  return {
    total: connectors.count,
    bySource: {
      shadow: of(CONNECTOR_SOURCE.shadow),
      patch: of(CONNECTOR_SOURCE.patch),
      primitive: of(CONNECTOR_SOURCE.primitive),
      inferred: of(CONNECTOR_SOURCE.inferred),
    },
    unverified,
  };
}

function inferredLoad(
  partId: string,
  inferred: InferredConnectorRecords | null,
  license: string,
): ConnectorLoad {
  if (inferred === null) return { kind: "unlisted" };
  const connectivity = inferred.connectivity && { ...inferred.connectivity, part: partId };
  const connectors = inferred.connectors && { ...inferred.connectors, part: partId };
  const issues = [
    ...(connectivity === null
      ? []
      : connectorRecordIssues("connectivity", [CONNECTIVITY_LICENSE], partId, connectivity, null)),
    ...(connectors === null
      ? []
      : connectorRecordIssues("connectors", [license], partId, connectors, null)),
  ];
  if (issues.length > 0) return { kind: "refused", reason: issues.join("; ") };
  const table = partConnectors([connectivity, connectors].filter((record) => record !== null));
  table.status.fill(CONNECTOR_STATUS.unverified);
  return { kind: "loaded", connectors: table };
}

function libraryKey(source: MirrorSource): string {
  return `${source.repo}@${source.commit}/${source.root}`;
}

export class ModelImportEngine {
  constructor(
    private readonly compiler: BrickCompiler,
    private readonly mirror: LdrawMirror,
    private readonly connectors: PartConnectorSource,
    private readonly records: IPartRecords | null,
    private readonly now: () => number,
    private readonly helpers: ReadonlyArray<IBakeHelper>,
    private readonly shadowLibrary: IShadowLibrary | null,
    private readonly glyphs: PlanGlyphCache | null = null,
  ) {}

  async importText(
    job: ImportJob,
    onPlaced: PlacementListener = IGNORE_PLACEMENT,
    customFiles: ReadonlyArray<CustomSource> = [],
  ): Promise<ImportResult> {
    const started = this.now();
    const spent = new TimeSpent(this.now);
    const read = this.compiler.readModel(job.text);
    const readAt = this.now();
    const library: ImportLibrary = {
      key: libraryKey(job.source),
      files: new Map(),
      absent: new Set(),
    };
    const bundleIds = new Set(job.bundlePartIds);
    const officialOf = new Map(read.inlineParts.map((part) => [part.inline, part.official]));
    const officials = new Set(read.parts.map((key) => officialOf.get(key) ?? key));
    const pinned = await spent.during("recordFetchMs", () => this.pinnedParts(job, officials));
    const outside = [...officials].filter((reference) => !bundleIds.has(bundlePartId(reference)));
    const outcomes = await this.resolveOutside(
      job,
      library,
      outside,
      read.inlineParts,
      pinned,
      spent,
    );
    const resolvedAt = this.now();
    const counts = instanceCounts(read);
    const resolved = read.parts.map((key, index) => {
      const official = officialOf.get(key);
      const instances = counts[index] ?? 0;
      return official === undefined
        ? officialResolution({ reference: key, official: key, instances }, bundleIds, outcomes)
        : inlineResolution({ reference: key, official, instances }, bundleIds, outcomes);
    });
    const custom = await this.compileCustom(job, library, resolved, customFiles, spent);
    const assembled = assemble(job, read, custom.parts, outcomes, custom);
    const loading = Promise.all(
      assembled.result.partIds.map(
        (partId) => custom.compiled.get(partId)?.connectors ?? this.connectors.read(partId),
      ),
    );
    const receptors = loading.then((loads) =>
      bakeReceptors(assembled.result.partIndex, loadedConnectors(loads)),
    );
    receptors.catch(() => undefined);
    const recordFiles = await spent.during("recordFetchMs", () =>
      this.recordFiles(read, assembled.drawn, officialOf, pinned),
    );
    const announce = async (placement: BakedModel): Promise<void> => {
      const loads = await loading.catch(() => null);
      if (loads === null) return;
      const { report, ...shape } = assembled.result;
      onPlaced({
        ...shape,
        sections: report.sections,
        connectors: loadedConnectors(loads),
        refusedConnectorRecords: refusedRecords(shape.partIds, loads),
        bake: placementBake(placement),
      });
    };
    const baked = await this.bakeDrawn(
      job,
      library,
      { mask: assembled.drawn, receptors },
      recordFiles,
      custom,
      spent,
      announce,
    );
    const loads = await loading;
    const connectors = loadedConnectors(loads);
    const bakedAt = this.now();
    const placedAt = baked.placedAt ?? bakedAt;
    return {
      ...assembled.result,
      connectors,
      bake: baked.bake,
      report: {
        ...assembled.result.report,
        withoutConnectorRecords: assembled.result.partIds.filter(
          (_, index) => loads[index]?.kind === "unlisted",
        ),
        refusedConnectorRecords: refusedRecords(assembled.result.partIds, loads),
        bakeRounds: baked.rounds,
        bakeIssue: baked.issue,
        bakeHelpersFailed: baked.helpersFailed,
        glyphFromCache: baked.glyphFromCache,
        fetched: this.mirror.stats(),
        records:
          this.records === null
            ? null
            : {
                pinnedParts: pinned.size,
                bakedFromRecords: baked.recordedParts,
                ...this.records.stats(),
              },
        shadowLibrary: this.shadowLibrary?.stats() ?? null,
        timings: {
          readMs: readAt - started,
          resolveMs: resolvedAt - readAt,
          bakeMs: bakedAt - resolvedAt,
          totalMs: bakedAt - started,
          placementMs: placedAt - started,
          ...spent.spent(),
          bakePhases: baked.phases,
          coverPhases: baked.coverPhases,
        },
      },
    };
  }

  private async fetchNeeded(
    library: ImportLibrary,
    needed: ReadonlySet<string>,
    spent: TimeSpent,
  ): Promise<void> {
    const unknown = [...needed].filter(
      (path) => !library.files.has(path) && !library.absent.has(path),
    );
    if (needed.size > 0 && unknown.length === 0) {
      throw new Error(`compiler keeps asking for files it already has: ${[...needed]}`);
    }
    const shadowPaths = unknown.filter(isShadowLibraryPath);
    const ldrawPaths = unknown.filter((path) => !isShadowLibraryPath(path));
    const probes = await Promise.all([
      spent.during("ldrawFetchMs", () => this.mirror.probe(ldrawPaths, FETCH_CONCURRENCY)),
      shadowPaths.length === 0
        ? NOTHING_PROBED
        : spent.during("shadowFetchMs", () =>
            this.requireShadowLibrary().probe(shadowPaths, FETCH_CONCURRENCY),
          ),
    ]);
    for (const probe of probes) {
      for (const [path, text] of probe.found) library.files.set(path, text);
      for (const path of probe.absent) library.absent.add(path);
    }
  }

  private requireShadowLibrary(): IShadowLibrary {
    if (this.shadowLibrary === null) {
      throw new Error("the compiler asked for shadow library files, but this import has none");
    }
    return this.shadowLibrary;
  }

  private async connectorInference(job: ImportJob, spent: TimeSpent): Promise<ConnectorInference> {
    const shadow = this.shadowLibrary;
    if (shadow === null || job.primitives === null) return NOT_INFERRED;
    try {
      return {
        kind: "inferred",
        manifest: await spent.during("shadowFetchMs", () => shadow.manifest()),
      };
    } catch (error) {
      const reason = `the pinned shadow library could not be read: ${error instanceof Error ? error.message : String(error)}`;
      return { kind: "notInferred", load: { kind: "refused", reason } };
    }
  }

  private async compileCustom(
    job: ImportJob,
    library: ImportLibrary,
    parts: ReadonlyArray<PartResolution>,
    customFiles: ReadonlyArray<CustomSource>,
    spent: TimeSpent,
  ): Promise<CustomPass> {
    const studioFiles = new Map(
      customFiles.map((file) => [normalizeReference(file.name), file.text] as const),
    );
    const origins = parts.map((part) => customOrigin(part, studioFiles));
    if (origins.every((origin) => origin === null)) {
      return {
        parts,
        compiled: new Map(),
        bakeSource: job.text,
        ownFiles: new Map(),
        unofficialAllowlist: job.unofficialAllowlist,
        rounds: 0,
      };
    }
    const sources = new Map([...mpdSections(job.text), ...studioFiles]);
    const closures = await Promise.all(
      parts.map((part, index) => {
        const origin = origins[index] ?? null;
        return origin === null ? null : customClosure(part.reference, sources);
      }),
    );
    const resolved = [...parts];
    const candidates: CustomCandidate[] = [];
    for (const [index, closure] of closures.entries()) {
      const part = parts[index];
      const origin = origins[index] ?? null;
      if (closure === null || part === undefined || origin === null) continue;
      if (closure.kind === "cycle") resolved[index] = cyclicRefusal(part, origin, closure);
      else candidates.push({ index, origin, closure });
    }
    const ownFiles = new Map(candidates.flatMap(({ closure }) => [...closure.files]));
    for (const [path, text] of ownFiles) {
      library.files.set(path, text);
      for (const directory of RESOLVER_DIRECTORIES) library.absent.add(`${directory}${path}`);
    }
    const references = candidates.map((candidate) => candidate.closure.path);
    const unofficialAllowlist = [...job.unofficialAllowlist, ...ownFiles.keys()];
    const inference =
      references.length === 0 ? NOT_INFERRED : await this.connectorInference(job, spent);
    const outcomes = await this.compileClosure(
      job,
      library,
      {
        parts: references,
        inlineChecks: [],
        unofficialAllowlist,
        infer: inference.kind === "inferred" ? references : NOTHING_INFERRED,
        shadowPatchManifest: inference.kind === "inferred" ? inference.manifest : null,
      },
      spent,
    );
    const compiled = new Map<string, CustomCompiled>();
    const renames = new Map<string, string>();
    for (const { index, origin, closure: custom } of candidates) {
      const part = parts[index];
      const outcome = outcomes.parts.get(custom.path);
      if (part === undefined || outcome === undefined) continue;
      const counted = {
        reference: part.reference,
        official: part.official,
        instances: part.instances,
      };
      if (outcome.status === "failed") {
        resolved[index] = {
          kind: "customRefused",
          ...counted,
          origin,
          gate: outcome.kind,
          path: withoutReservedPaths(outcome.path ?? custom.reference),
          message: withoutReservedPaths(outcome.message),
          difference: inlineDifference(part),
        };
        continue;
      }
      const connectors =
        inference.kind === "inferred"
          ? inferredLoad(custom.partId, outcome.connectors, outcome.header.license ?? "")
          : inference.load;
      compiled.set(custom.partId, { glb: outcome.glb, connectors });
      renames.set(part.reference, custom.path);
      resolved[index] = {
        kind: "custom",
        ...counted,
        partId: custom.partId,
        origin,
        file: outcome.file,
        header: outcome.header,
        sourceFiles: outcome.files,
        connectors: connectorCounts(connectors),
        difference: inlineDifference(part),
      };
    }
    return {
      parts: resolved,
      compiled,
      bakeSource: renameReferences(job.text, renames),
      ownFiles,
      unofficialAllowlist,
      rounds: outcomes.rounds,
    };
  }

  private async pinnedParts(
    job: ImportJob,
    officials: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, LibraryBakePart>> {
    if (this.records === null) return new Map();
    const references = new Map(
      [...officials].map((reference) => [bundlePartId(reference), reference]),
    );
    const found = await this.records
      .lookup([...references.keys()], {
        source: job.source,
        studPrimitives: job.studPrimitives,
        unofficialAllowlist: job.unofficialAllowlist,
        primitives: job.primitives,
      })
      .catch(() => new Map<string, LibraryBakePart>());
    const pinned = new Map<string, LibraryBakePart>();
    for (const [id, part] of found) {
      const reference = references.get(id);
      if (reference !== undefined) pinned.set(reference, part);
    }
    return pinned;
  }

  private async recordFiles(
    read: ModelRead,
    drawn: Uint8Array,
    officialOf: ReadonlyMap<string, string>,
    pinned: ReadonlyMap<string, LibraryBakePart>,
  ): Promise<RecordFiles | null> {
    const records = this.records;
    if (records === null || pinned.size === 0) return null;
    const wanted = new Set<string>();
    for (const [i, isDrawn] of drawn.entries()) {
      if (isDrawn === 0) continue;
      const key = read.parts[read.instancePart[i] ?? 0] ?? "";
      const official = officialOf.get(key) ?? key;
      if (pinned.has(official)) wanted.add(official);
    }
    const fetched = await Promise.all(
      [...wanted].map(async (reference): Promise<readonly [string, Uint8Array] | null> => {
        const part = pinned.get(reference);
        if (part === undefined) return null;
        return records.bytes(part.record).then(
          (bytes) => [reference, bytes] as const,
          () => null,
        );
      }),
    );
    const files = new Map(fetched.filter((entry) => entry !== null));
    return { key: records.key, files };
  }

  private async bakeDrawn(
    job: ImportJob,
    library: ImportLibrary,
    drawn: DrawnInstances,
    records: RecordFiles | null,
    {
      bakeSource,
      ownFiles,
      unofficialAllowlist,
    }: Pick<CustomPass, "bakeSource" | "ownFiles" | "unofficialAllowlist">,
    spent: TimeSpent,
    announce: (placement: BakedModel) => Promise<void>,
  ): Promise<BakeRounds> {
    if (!drawn.mask.includes(1)) {
      return {
        bake: null,
        issue: "nothing in the file is drawn",
        rounds: 0,
        helpersFailed: 0,
        glyphFromCache: false,
        recordedParts: 0,
        phases: null,
        coverPhases: null,
        placedAt: null,
      };
    }
    const inputs: BakeInputs = {
      source: bakeSource,
      drawn: drawn.mask,
      studPrimitives: job.studPrimitives,
      unofficialAllowlist,
      translucentColors: job.translucentColors,
      tableDepthLdu: job.tableDepthLdu,
      vehicles: job.vehicles,
    };
    const cached = (await this.glyphs?.entry(library.key, inputs, ownFiles)) ?? UNCACHED_GLYPH;
    const of = HELPER_SLICES * this.helpers.length + PRIMARY_SLICES;
    const visibility = (from: number, slices: number): VisibilityBakeRequest => ({
      ...inputs,
      shard: { from, to: from + slices, of, visibilityOnly: true },
    });
    const primaryCoverRequest = { ...visibility(0, PRIMARY_SLICES), glyph: cached.glyph === null };
    const helped = this.helpers.map((helper, index) => ({
      helper,
      request: visibility(PRIMARY_SLICES + HELPER_SLICES * index, HELPER_SLICES),
    }));
    let helpersFailed = 0;
    for (let rounds = 1; rounds <= MAX_COMPILE_ROUNDS; rounds++) {
      const needs = this.compiler.bakeNeeds(inputs, library, records);
      if (needs.status === "need") {
        await this.fetchNeeded(library, new Set(needs.paths), spent);
        continue;
      }
      const assisted = helped.map(({ helper, request }) => ({
        request,
        outcome: helper.bake(request, library, records),
      }));
      const placementRequest: PlacementBakeRequest = {
        ...inputs,
        receptors: await drawn.receptors,
        shard: { from: 0, to: 0, of, visibilityOnly: false },
        keepParts: true,
      };
      const primaryStarted = this.now();
      const placement = this.compiler.bake(placementRequest, library, records);
      if (placement.status === "baked") await announce(placement);
      const placedAt = this.now();
      const primaryCover =
        placement.status === "baked"
          ? this.compiler.bake(primaryCoverRequest, library, records)
          : null;
      const deadlineMs =
        HELPER_DEADLINE_PER_PRIMARY_MS * (this.now() - primaryStarted) + HELPER_DEADLINE_SLACK_MS;
      const answered = await Promise.all(
        assisted.map(async ({ request, outcome }) => ({
          request,
          outcome: await settledWithin(outcome, deadlineMs),
        })),
      );
      const outcomes = primaryCover === null ? [placement] : [placement, primaryCover];
      for (const { request, outcome } of answered) {
        if (outcome !== null && !asksForHeldFiles(outcome, library)) {
          outcomes.push(outcome);
          continue;
        }
        helpersFailed++;
        outcomes.push(this.compiler.bake(request, library, records));
      }
      const needed = new Set(
        outcomes.flatMap((outcome) => (outcome.status === "need" ? outcome.paths : [])),
      );
      if (needed.size > 0) {
        await this.fetchNeeded(library, needed, spent);
        continue;
      }
      const baked: BakedModel[] = [];
      for (const outcome of outcomes) {
        switch (outcome.status) {
          case "baked":
            baked.push(outcome);
            break;
          case "failed":
            return {
              bake: null,
              issue: withoutReservedPaths(outcome.message),
              rounds,
              helpersFailed,
              glyphFromCache: false,
              recordedParts: 0,
              phases: null,
              coverPhases: null,
              placedAt: null,
            };
          case "need":
            throw new Error("a bake shard asked for files after the round that fetched them");
          default: {
            const unhandled: never = outcome;
            throw new Error(`unhandled bake outcome ${String(unhandled)}`);
          }
        }
      }
      const [first, ...others] = baked;
      if (!first) throw new Error("the bake round returned no shard");
      const cover = primaryCover?.status === "baked" ? primaryCover : null;
      if (cached.glyph === null && cover?.glyph) await cached.keep(cover.glyph);
      return {
        bake: {
          ...joinedShards(first, others),
          glyph: cached.glyph ?? cover?.glyph ?? null,
          glyphIssue: cover?.glyphIssue ?? null,
        },
        issue: null,
        rounds,
        helpersFailed,
        glyphFromCache: cached.glyph !== null,
        recordedParts: first.recordedParts,
        phases: first.phases,
        coverPhases: cover?.phases ?? null,
        placedAt,
      };
    }
    throw new Error(`bake closure still growing after ${MAX_COMPILE_ROUNDS} rounds`);
  }

  private async fromRecords(
    job: ImportJob,
    outside: ReadonlyArray<string>,
    pinned: ReadonlyMap<string, LibraryBakePart>,
  ): Promise<ReadonlyArray<Extract<PartOutcome, { status: "compiled" }>>> {
    const records = this.records;
    if (records === null || job.lod !== RECORDED_LOD) return [];
    const outcomes = await Promise.all(
      outside.map(async (reference) => {
        const part = pinned.get(reference);
        if (part === undefined) return null;
        return records.bytes(part.glb).then(
          (glb) => compiledFromGlb(reference, glb),
          () => null,
        );
      }),
    );
    return outcomes.filter((outcome) => outcome !== null);
  }

  private async resolveOutside(
    job: ImportJob,
    library: ImportLibrary,
    outside: ReadonlyArray<string>,
    inlineParts: ReadonlyArray<InlinePart>,
    pinned: ReadonlyMap<string, LibraryBakePart>,
    spent: TimeSpent,
  ): Promise<Outcomes> {
    const parts = new Map<string, Exclude<PartOutcome, { status: "need" }>>();
    const recorded = await spent.during("recordFetchMs", () =>
      this.fromRecords(job, outside, pinned),
    );
    const fromLibraryBake = new Set<string>();
    for (const outcome of recorded) {
      parts.set(outcome.reference, outcome);
      fromLibraryBake.add(outcome.reference);
    }
    const closure = await this.compileClosure(
      job,
      library,
      {
        parts: outside.filter((reference) => !parts.has(reference)),
        inlineChecks: inlineParts,
        unofficialAllowlist: job.unofficialAllowlist,
        infer: NOTHING_INFERRED,
        shadowPatchManifest: null,
      },
      spent,
    );
    for (const [reference, outcome] of closure.parts) parts.set(reference, outcome);
    const { inline, rounds, weldEpsilonLdu } = closure;
    return { parts, inline, rounds, weldEpsilonLdu, fromLibraryBake };
  }

  private async compileClosure(
    job: ImportJob,
    library: ImportLibrary,
    request: ClosureRequest,
    spent: TimeSpent,
  ): Promise<CompiledClosure> {
    const parts = new Map<string, Exclude<PartOutcome, { status: "need" }>>();
    const inline = new Map<string, Exclude<InlineOutcome, { status: "need" }>>();
    let pendingParts = [...request.parts];
    let pendingChecks = [...request.inlineChecks];
    let weldEpsilonLdu = 0;
    let rounds = 0;
    while (pendingParts.length > 0 || pendingChecks.length > 0) {
      if (rounds === MAX_COMPILE_ROUNDS) {
        throw new Error(`part closure still growing after ${MAX_COMPILE_ROUNDS} rounds`);
      }
      rounds++;
      const compileRequest = {
        lod: job.lod,
        studPrimitives: job.studPrimitives,
        unofficialAllowlist: request.unofficialAllowlist,
        connectors: {
          primitives: job.primitives,
          sectionVocabulary: job.sectionVocabulary,
          cavityProbe: job.cavityProbe,
          infer: request.infer,
          shadowPatchManifest: request.shadowPatchManifest,
        },
        parts: pendingParts,
        model: job.text,
        inlineChecks: pendingChecks,
      };
      const output = spent.inside("compileMs", () =>
        this.compiler.compile(compileRequest, library),
      );
      weldEpsilonLdu = output.weldEpsilonLdu;
      const needed = new Set<string>();
      pendingParts = [];
      for (const outcome of output.parts) {
        if (outcome.status === "need") {
          outcome.paths.forEach((path) => needed.add(path));
          pendingParts.push(outcome.reference);
        } else {
          parts.set(outcome.reference, outcome);
        }
      }
      pendingChecks = [];
      for (const outcome of output.inline) {
        if (outcome.status === "need") {
          outcome.paths.forEach((path) => needed.add(path));
          pendingChecks.push({ inline: outcome.inline, official: outcome.official });
        } else {
          inline.set(outcome.inline, outcome);
        }
      }
      await this.fetchNeeded(library, needed, spent);
    }
    return { parts, inline, rounds, weldEpsilonLdu };
  }
}

function compiledFromGlb(
  reference: string,
  glb: Uint8Array,
): Extract<PartOutcome, { status: "compiled" }> | null {
  try {
    const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
    const { ldraw, sources } = parseGlb(bytes as ArrayBuffer, reference).document.extras;
    return {
      status: "compiled",
      reference,
      glb,
      record: null,
      glyph: null,
      file: ldraw.file,
      header: {
        name: ldraw.name,
        title: ldraw.title,
        author: ldraw.author,
        license: ldraw.license,
        ldrawOrg: ldraw.ldrawOrg,
      },
      files: sources.length,
      connectors: null,
    };
  } catch {
    return null;
  }
}

function instanceCounts(read: ModelRead): Uint32Array {
  const counts = new Uint32Array(read.parts.length);
  for (const part of read.instancePart) counts[part] = (counts[part] ?? 0) + 1;
  return counts;
}

function failureResolution(
  counted: Counted,
  failure: Failure,
  definedInline: boolean,
): PartResolution {
  switch (failure.kind) {
    case "unresolved":
      if (failure.from === "" || failure.from === undefined) {
        return { kind: "notInLibrary", ...counted, definedInline };
      }
      return {
        kind: "missingSubfile",
        ...counted,
        missing: failure.missing ?? "",
        from: failure.from,
      };
    case "unofficial":
      return {
        kind: "rejected",
        ...counted,
        gate: failure.kind,
        path: failure.path ?? counted.official,
        message: failure.message,
      };
    case "malformed":
      return {
        kind: "malformed",
        ...counted,
        findings: failure.findings ?? [],
        message: failure.message,
      };
    case "tooLarge":
      if (failure.cause === undefined) {
        throw new Error(`${counted.official}: a tooLarge failure arrived without its cause`);
      }
      return { kind: "tooLarge", ...counted, cause: failure.cause, message: failure.message };
    case "tooDeep":
    case "noStudRing":
      return { kind: "failed", ...counted, message: failure.message };
    default: {
      const unhandled: never = failure.kind;
      throw new Error(`unhandled failure ${String(unhandled)}`);
    }
  }
}

function officialResolution(
  counted: Counted,
  bundleIds: ReadonlySet<string>,
  outcomes: Outcomes,
): PartResolution {
  const partId = bundlePartId(counted.official);
  if (bundleIds.has(partId)) return { kind: "bundle", ...counted, partId };
  const outcome = outcomes.parts.get(counted.official);
  if (!outcome) throw new Error(`no compile outcome for ${counted.official}`);
  switch (outcome.status) {
    case "compiled":
      return {
        kind: "compiled",
        ...counted,
        partId,
        file: outcome.file,
        header: outcome.header,
        sourceFiles: outcome.files,
      };
    case "failed":
      return failureResolution(counted, outcome, counted.reference !== counted.official);
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled outcome ${String(unhandled)}`);
    }
  }
}

function inlineResolution(
  counted: Counted,
  bundleIds: ReadonlySet<string>,
  outcomes: Outcomes,
): PartResolution {
  const check = outcomes.inline.get(counted.reference);
  if (!check) throw new Error(`no inline comparison for ${counted.reference}`);
  switch (check.status) {
    case "measured":
      if (check.withinWeld) return officialResolution(counted, bundleIds, outcomes);
      return {
        kind: "inlineDiffers",
        ...counted,
        colorsMatch: check.colorsMatch,
        inlineColors: check.inlineColors,
        officialColors: check.officialColors,
        maxMeasuredDistanceLdu: check.maxMeasuredDistanceLdu,
        surfaceWithinWeld: check.surfaceWithinWeld,
        weldEpsilonLdu: outcomes.weldEpsilonLdu,
      };
    case "failed":
      return failureResolution(counted, check, true);
    default: {
      const unhandled: never = check;
      throw new Error(`unhandled inline outcome ${String(unhandled)}`);
    }
  }
}

function isDrawable(
  part: PartResolution,
): part is Extract<PartResolution, { kind: "bundle" | "compiled" | "custom" }> {
  return part.kind === "bundle" || part.kind === "compiled" || part.kind === "custom";
}

function assemble(
  job: ImportJob,
  read: ModelRead,
  parts: ReadonlyArray<PartResolution>,
  outcomes: Outcomes,
  custom: CustomPass,
): Assembled {
  const ldconfig = new Set(job.ldconfigCodes);
  const unknownColors = new Map<number, number>();
  const directColors = new Set<number>();
  const localIndex = new Map<string, number>();
  const partIds: string[] = [];
  const part = read.instancePart;
  const color = read.instanceColor;
  const transform = read.instanceTransform;
  const submodel = read.instanceSubmodel;
  const total = part.length;
  const partIndex = new Uint32Array(total);
  const ldrawColor = new Uint32Array(total);
  const matrices = new Float32Array(total * MATRIX_FLOATS);
  const partTransforms = new Float64Array(total * MATRIX_FLOATS);
  const ofPart = new Int32Array(total);
  const drawnMask = new Uint8Array(total);
  let drawn = 0;
  for (let i = 0; i < total; i++) {
    const source = part[i] ?? 0;
    const code = color[i] ?? 0;
    const resolved = parts[source];
    if (!resolved || !isDrawable(resolved)) continue;
    if (isDirectColor(code)) {
      directColors.add(code);
    } else if (!ldconfig.has(code)) {
      unknownColors.set(code, (unknownColors.get(code) ?? 0) + 1);
      continue;
    }
    let local = localIndex.get(resolved.partId);
    if (local === undefined) {
      local = partIds.length;
      localIndex.set(resolved.partId, local);
      partIds.push(resolved.partId);
    }
    partIndex[drawn] = local;
    ldrawColor[drawn] = code;
    const row = transform.subarray(i * MATRIX_FLOATS, (i + 1) * MATRIX_FLOATS);
    partTransforms.set(row, drawn * MATRIX_FLOATS);
    matrices.set(row, drawn * MATRIX_FLOATS);
    ofPart[drawn] = submodel[i] ?? MODEL_ROOT;
    drawnMask[i] = 1;
    drawn++;
  }
  const submodels: ImportedSubmodels = {
    count: read.submodelParent.length,
    parent: read.submodelParent,
    matrices: read.submodelMatrix,
    ofPart: ofPart.slice(0, drawn),
  };
  if (!submodelTreeFits(submodels, drawn)) {
    throw new Error(`${job.fileName}: the bake returned an inconsistent sub-model tree`);
  }
  const compiled: CompiledGlb[] = [];
  const compiledIds = new Set<string>();
  for (const resolved of parts) {
    if (resolved.kind !== "compiled" && resolved.kind !== "custom") continue;
    if (compiledIds.has(resolved.partId) || !localIndex.has(resolved.partId)) continue;
    const glb =
      resolved.kind === "custom"
        ? custom.compiled.get(resolved.partId)?.glb
        : compiledGlb(outcomes.parts.get(resolved.official));
    if (glb === undefined) continue;
    compiledIds.add(resolved.partId);
    compiled.push({
      partId: resolved.partId,
      glb,
      source:
        resolved.kind === "compiled" && outcomes.fromLibraryBake.has(resolved.official)
          ? "library-bake"
          : "import",
    });
  }
  return {
    drawn: drawnMask,
    result: {
      report: {
        fileName: job.fileName,
        mirror: job.source,
        lod: job.lod,
        sections: read.sections,
        instanceCount: total,
        drawnInstanceCount: drawn,
        parts,
        inlineParts: read.inlineParts,
        looseGeometry: read.looseGeometry,
        unknownColors: [...unknownColors].map(([code, instances]) => ({ code, instances })),
        directColors: [...directColors],
        compileRounds: outcomes.rounds + custom.rounds,
      },
      partIds,
      instanceCount: drawn,
      partIndex: partIndex.slice(0, drawn),
      ldrawColor: ldrawColor.slice(0, drawn),
      matrices: matrices.slice(0, drawn * MATRIX_FLOATS),
      partTransforms: partTransforms.slice(0, drawn * MATRIX_FLOATS),
      submodels,
      compiled,
    },
  };
}

function compiledGlb(
  outcome: Exclude<PartOutcome, { status: "need" }> | undefined,
): Uint8Array | undefined {
  return outcome?.status === "compiled" ? outcome.glb : undefined;
}
