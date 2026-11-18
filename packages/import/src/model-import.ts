import type { ConnectorLoad, PartConnectors } from "@brr/catalog/connector-records";
import type {
  BakedModel,
  BakeOutcome,
  BakeRequest,
  BrickCompiler,
  CompileLod,
  Failure,
  InlineOutcome,
  InlinePart,
  LdrawHeader,
  LibraryFiles,
  LooseGeometry,
  ModelRead,
  PartOutcome,
} from "./brick-compiler.ts";
import { isDirectColor } from "@brr/catalog/colors";
import {
  submodelTreeFits,
  type CompilerVehicles,
  type PrimitiveConnectorTable,
  type SectionVocabulary,
} from "@brr/schema/bundle";
import { MODEL_ROOT, type SubmodelInstances } from "@brr/domain";
import type { LdrawMirror, MirrorSource, MirrorStats } from "./ldraw-mirror.ts";
import type { StudioReport } from "./studio-import.ts";

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

export type PartResolution =
  | (Counted & { readonly kind: "bundle"; readonly partId: string })
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
      readonly gate: "license" | "unofficial";
      readonly path: string;
      readonly message: string;
    })
  | (Counted & {
      readonly kind: "inlineDiffers";
      readonly colorsMatch: boolean;
      readonly inlineColors: ReadonlyArray<number>;
      readonly officialColors: ReadonlyArray<number>;
      readonly maxMeasuredDistanceLdu: number;
      readonly surfaceWithinWeld: boolean;
      readonly weldEpsilonLdu: number;
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
  readonly fetched: MirrorStats;
  readonly timings: ImportTimings;
}

export interface ImportedSubmodels extends SubmodelInstances {
  readonly parent: Int32Array;
  readonly ofPart: Int32Array;
}

export interface CompiledGlb {
  readonly partId: string;
  readonly glb: Uint8Array;
}

export type ModelBake = Omit<BakedModel, "status">;

export interface IBakeHelper {
  bake(request: BakeRequest, library: LibraryFiles): Promise<BakeOutcome>;
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
const ONLY_PINNED_PARTS_ARE_COMPILED: ReadonlyArray<string> = [];
const PRIMARY_SLICES = 1;
const HELPER_SLICES = 2;
const HELPER_DEADLINE_PER_PRIMARY_MS = 4;
const HELPER_DEADLINE_SLACK_MS = 5_000;
const FETCH_CONCURRENCY = 16;
const MATRIX_FLOATS = 12;

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

function joinedShards(primary: BakedModel, others: ReadonlyArray<BakedModel>): ModelBake {
  const { status: _baked, ...bake } = primary;
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

export function bundlePartId(reference: string): string {
  return `ldraw:${reference.replace(/(\.dat)+$/u, "").replaceAll("/", "-")}`;
}

interface Outcomes {
  readonly parts: Map<string, Exclude<PartOutcome, { status: "need" }>>;
  readonly inline: Map<string, Exclude<InlineOutcome, { status: "need" }>>;
  readonly rounds: number;
  readonly weldEpsilonLdu: number;
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
      | "fetched"
      | "timings"
      | "withoutConnectorRecords"
      | "refusedConnectorRecords"
    >;
  };
  readonly drawn: Uint8Array;
}

interface BakeRounds {
  readonly bake: ModelBake | null;
  readonly issue: string | null;
  readonly rounds: number;
  readonly helpersFailed: number;
}

function libraryKey(source: MirrorSource): string {
  return `${source.repo}@${source.commit}/${source.root}`;
}

export class ModelImportEngine {
  constructor(
    private readonly compiler: BrickCompiler,
    private readonly mirror: LdrawMirror,
    private readonly connectors: PartConnectorSource,
    private readonly now: () => number,
    private readonly helpers: ReadonlyArray<IBakeHelper>,
  ) {}

  async importText(job: ImportJob): Promise<ImportResult> {
    const started = this.now();
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
    const outside = [...officials].filter((reference) => !bundleIds.has(bundlePartId(reference)));
    const outcomes = await this.resolveOutside(job, library, outside, read.inlineParts);
    const resolvedAt = this.now();
    const counts = instanceCounts(read);
    const parts = read.parts.map((key, index) => {
      const official = officialOf.get(key);
      const instances = counts[index] ?? 0;
      return official === undefined
        ? officialResolution({ reference: key, official: key, instances }, bundleIds, outcomes)
        : inlineResolution({ reference: key, official, instances }, bundleIds, outcomes);
    });
    const assembled = assemble(job, read, parts, outcomes);
    const baked = await this.bakeDrawn(job, library, assembled.drawn);
    const loads = await Promise.all(
      assembled.result.partIds.map((partId) => this.connectors.read(partId)),
    );
    const connectors = loads.map((load) => (load.kind === "loaded" ? load.connectors : null));
    const bakedAt = this.now();
    return {
      ...assembled.result,
      connectors,
      bake: baked.bake,
      report: {
        ...assembled.result.report,
        withoutConnectorRecords: assembled.result.partIds.filter(
          (_, index) => loads[index]?.kind === "unlisted",
        ),
        refusedConnectorRecords: assembled.result.partIds.flatMap((partId, index) => {
          const load = loads[index];
          return load?.kind === "refused" ? [{ partId, reason: load.reason }] : [];
        }),
        bakeRounds: baked.rounds,
        bakeIssue: baked.issue,
        bakeHelpersFailed: baked.helpersFailed,
        fetched: this.mirror.stats(),
        timings: {
          readMs: readAt - started,
          resolveMs: resolvedAt - readAt,
          bakeMs: bakedAt - resolvedAt,
          totalMs: bakedAt - started,
        },
      },
    };
  }

  private async fetchNeeded(library: ImportLibrary, needed: ReadonlySet<string>): Promise<void> {
    const unknown = [...needed].filter(
      (path) => !library.files.has(path) && !library.absent.has(path),
    );
    if (needed.size > 0 && unknown.length === 0) {
      throw new Error(`compiler keeps asking for files it already has: ${[...needed]}`);
    }
    const probe = await this.mirror.probe(unknown, FETCH_CONCURRENCY);
    for (const [path, text] of probe.found) library.files.set(path, text);
    for (const path of probe.absent) library.absent.add(path);
  }

  private async bakeDrawn(
    job: ImportJob,
    library: ImportLibrary,
    drawn: Uint8Array,
  ): Promise<BakeRounds> {
    if (!drawn.includes(1)) {
      return { bake: null, issue: "nothing in the file is drawn", rounds: 0, helpersFailed: 0 };
    }
    const request: BakeRequest = {
      source: job.text,
      drawn,
      studPrimitives: job.studPrimitives,
      unofficialAllowlist: job.unofficialAllowlist,
      translucentColors: job.translucentColors,
      tableDepthLdu: job.tableDepthLdu,
      vehicles: job.vehicles,
    };
    const of = HELPER_SLICES * this.helpers.length + PRIMARY_SLICES;
    const primaryRequest: BakeRequest =
      this.helpers.length === 0
        ? request
        : { ...request, shard: { from: 0, to: PRIMARY_SLICES, of, visibilityOnly: false } };
    const helperRequests = this.helpers.map((_, index): BakeRequest => {
      const from = PRIMARY_SLICES + HELPER_SLICES * index;
      return { ...request, shard: { from, to: from + HELPER_SLICES, of, visibilityOnly: true } };
    });
    let helpersFailed = 0;
    for (let rounds = 1; rounds <= MAX_COMPILE_ROUNDS; rounds++) {
      const needs = this.compiler.bakeNeeds(request, library);
      if (needs.status === "need") {
        await this.fetchNeeded(library, new Set(needs.paths));
        continue;
      }
      const assisted = this.helpers.map((helper, index) =>
        helper.bake(helperRequests[index] ?? request, library),
      );
      const primaryStarted = this.now();
      const primary = this.compiler.bake(primaryRequest, library);
      const deadlineMs =
        HELPER_DEADLINE_PER_PRIMARY_MS * (this.now() - primaryStarted) + HELPER_DEADLINE_SLACK_MS;
      const answered = await Promise.all(
        assisted.map((outcome) => settledWithin(outcome, deadlineMs)),
      );
      const outcomes = [primary];
      for (const [index, outcome] of answered.entries()) {
        if (outcome !== null && !asksForHeldFiles(outcome, library)) {
          outcomes.push(outcome);
          continue;
        }
        helpersFailed++;
        outcomes.push(this.compiler.bake(helperRequests[index] ?? request, library));
      }
      const needed = new Set(
        outcomes.flatMap((outcome) => (outcome.status === "need" ? outcome.paths : [])),
      );
      if (needed.size > 0) {
        await this.fetchNeeded(library, needed);
        continue;
      }
      const baked: BakedModel[] = [];
      for (const outcome of outcomes) {
        switch (outcome.status) {
          case "baked":
            baked.push(outcome);
            break;
          case "failed":
            return { bake: null, issue: outcome.message, rounds, helpersFailed };
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
      return { bake: joinedShards(first, others), issue: null, rounds, helpersFailed };
    }
    throw new Error(`bake closure still growing after ${MAX_COMPILE_ROUNDS} rounds`);
  }

  private async resolveOutside(
    job: ImportJob,
    library: ImportLibrary,
    outside: ReadonlyArray<string>,
    inlineParts: ReadonlyArray<InlinePart>,
  ): Promise<Outcomes> {
    const parts = new Map<string, Exclude<PartOutcome, { status: "need" }>>();
    const inline = new Map<string, Exclude<InlineOutcome, { status: "need" }>>();
    let pendingParts = [...outside];
    let pendingChecks = [...inlineParts];
    let weldEpsilonLdu = 0;
    let rounds = 0;
    while (pendingParts.length > 0 || pendingChecks.length > 0) {
      if (rounds === MAX_COMPILE_ROUNDS) {
        throw new Error(`part closure still growing after ${MAX_COMPILE_ROUNDS} rounds`);
      }
      rounds++;
      const output = this.compiler.compile(
        {
          lod: job.lod,
          studPrimitives: job.studPrimitives,
          unofficialAllowlist: job.unofficialAllowlist,
          connectors: {
            primitives: job.primitives,
            sectionVocabulary: job.sectionVocabulary,
            cavityProbe: job.cavityProbe,
            infer: ONLY_PINNED_PARTS_ARE_COMPILED,
          },
          parts: pendingParts,
          model: job.text,
          inlineChecks: pendingChecks,
        },
        library,
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
      await this.fetchNeeded(library, needed);
    }
    return { parts, inline, rounds, weldEpsilonLdu };
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
    case "license":
    case "unofficial":
      return {
        kind: "rejected",
        ...counted,
        gate: failure.kind,
        path: failure.path ?? counted.official,
        message: failure.message,
      };
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
): part is Extract<PartResolution, { kind: "bundle" | "compiled" }> {
  return part.kind === "bundle" || part.kind === "compiled";
}

function assemble(
  job: ImportJob,
  read: ModelRead,
  parts: ReadonlyArray<PartResolution>,
  outcomes: Outcomes,
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
    if (resolved.kind !== "compiled" || compiledIds.has(resolved.partId)) continue;
    if (!localIndex.has(resolved.partId)) continue;
    const outcome = outcomes.parts.get(resolved.official);
    if (outcome?.status !== "compiled") continue;
    compiledIds.add(resolved.partId);
    compiled.push({ partId: resolved.partId, glb: outcome.glb });
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
        compileRounds: outcomes.rounds,
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
