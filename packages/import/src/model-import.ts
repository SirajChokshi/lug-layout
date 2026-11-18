import {
  partConnectors,
  type ConnectorLoad,
  type PartConnectors,
} from "@brr/catalog/connector-records";
import type {
  BakedModel,
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
} from "./brick-compiler.ts";
import {
  customClosure,
  mpdSections,
  normalizeReference,
  renameReferences,
  type CustomClosure,
  type CustomSource,
  withoutReservedPaths,
} from "./custom-parts.ts";
import { isDirectColor } from "@brr/catalog/colors";
import {
  CONNECTOR_SOURCE,
  CONNECTOR_STATUS,
  type CompilerVehicles,
  type PrimitiveConnectorTable,
  type SectionVocabulary,
} from "@brr/schema/bundle";
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

export interface CustomConnectorCounts {
  readonly total: number;
  readonly primitive: number;
  readonly inferred: number;
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
      readonly connectors: CustomConnectorCounts;
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
      readonly gate: "license" | "unofficial";
      readonly path: string;
      readonly message: string;
    })
  | (Counted & InlineDifference & { readonly kind: "inlineDiffers" })
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
  readonly fetched: MirrorStats;
  readonly timings: ImportTimings;
}

export interface CompiledGlb {
  readonly partId: string;
  readonly glb: Uint8Array;
}

export type ModelBake = Omit<BakedModel, "status">;

export interface ImportResult {
  readonly report: ImportReport;
  readonly partIds: ReadonlyArray<string>;
  readonly instanceCount: number;
  readonly partIndex: Uint32Array;
  readonly ldrawColor: Uint32Array;
  readonly matrices: Float32Array;
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
const RESOLVER_DIRECTORIES: ReadonlyArray<string> = ["p/8/", "parts/", "p/"];
const FETCH_CONCURRENCY = 16;
const MATRIX_FLOATS = 12;

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
}

interface CustomCandidate {
  readonly index: number;
  readonly origin: CustomOrigin;
  readonly closure: CustomClosure;
}

interface CustomCompiled {
  readonly glb: Uint8Array;
  readonly connectors: PartConnectors | null;
}

interface CustomCompileRequest {
  readonly references: ReadonlyArray<string>;
  readonly infer: ReadonlyArray<string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
}

interface CustomPass {
  readonly parts: ReadonlyArray<PartResolution>;
  readonly compiled: ReadonlyMap<string, CustomCompiled>;
  readonly bakeSource: string;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly rounds: number;
}

function customOrigin(
  part: PartResolution,
  studioFiles: ReadonlyMap<string, string>,
): CustomOrigin | null {
  if (studioFiles.has(normalizeReference(part.reference))) return "studio";
  if (part.kind === "inlineDiffers") return "inlineDiffers";
  return part.kind === "notInLibrary" && part.definedInline ? "mpd" : null;
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

function connectorCounts(connectors: PartConnectors | null): CustomConnectorCounts {
  let primitive = 0;
  let inferred = 0;
  let unverified = 0;
  for (let face = 0; face < (connectors?.count ?? 0); face++) {
    const source = connectors?.source[face];
    if (source === CONNECTOR_SOURCE.primitive) primitive++;
    if (source === CONNECTOR_SOURCE.inferred) inferred++;
    if (connectors?.status[face] === CONNECTOR_STATUS.unverified) unverified++;
  }
  return { total: connectors?.count ?? 0, primitive, inferred, unverified };
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
  ) {}

  async importText(
    job: ImportJob,
    customFiles: ReadonlyArray<CustomSource> = [],
  ): Promise<ImportResult> {
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
    const resolved = read.parts.map((key, index) => {
      const official = officialOf.get(key);
      const instances = counts[index] ?? 0;
      return official === undefined
        ? officialResolution({ reference: key, official: key, instances }, bundleIds, outcomes)
        : inlineResolution({ reference: key, official, instances }, bundleIds, outcomes);
    });
    const custom = await this.compileCustom(job, library, resolved, customFiles);
    const assembled = assemble(job, read, custom.parts, outcomes, custom);
    const baked = await this.bakeDrawn(job, library, assembled.drawn, custom);
    const loads = await Promise.all(
      assembled.result.partIds.map((partId): Promise<ConnectorLoad> | ConnectorLoad => {
        const compiled = custom.compiled.get(partId);
        if (!compiled) return this.connectors.read(partId);
        return compiled.connectors
          ? { kind: "loaded", connectors: compiled.connectors }
          : { kind: "unlisted" };
      }),
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

  private async compileCustom(
    job: ImportJob,
    library: ImportLibrary,
    parts: ReadonlyArray<PartResolution>,
    customFiles: ReadonlyArray<CustomSource>,
  ): Promise<CustomPass> {
    const studioFiles = new Map(
      customFiles.map((file) => [normalizeReference(file.name), file.text] as const),
    );
    const sources = new Map([...mpdSections(job.text), ...studioFiles]);
    const candidates: CustomCandidate[] = [];
    for (const [index, part] of parts.entries()) {
      const origin = customOrigin(part, studioFiles);
      if (origin === null) continue;
      const closure = await customClosure(part.reference, sources);
      if (closure !== null) candidates.push({ index, origin, closure });
    }
    if (candidates.length === 0) {
      return {
        parts,
        compiled: new Map(),
        bakeSource: job.text,
        unofficialAllowlist: job.unofficialAllowlist,
        rounds: 0,
      };
    }
    for (const { closure } of candidates) {
      for (const [path, text] of closure.files) {
        library.files.set(path, text);
        for (const directory of RESOLVER_DIRECTORIES) library.absent.add(`${directory}${path}`);
      }
    }
    const references = candidates.map((candidate) => candidate.closure.path);
    const usersOwnFiles = candidates.flatMap((candidate) => [...candidate.closure.files.keys()]);
    const unofficialAllowlist = [...job.unofficialAllowlist, ...usersOwnFiles];
    const { outcomes, rounds } = await this.compileReferences(job, library, {
      references,
      infer: references,
      unofficialAllowlist,
    });
    const resolved = [...parts];
    const compiled = new Map<string, CustomCompiled>();
    const renames = new Map<string, string>();
    for (const { index, origin, closure } of candidates) {
      const part = parts[index];
      const outcome = outcomes.get(closure.path);
      if (!part || !outcome) continue;
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
          path: withoutReservedPaths(outcome.path ?? closure.reference),
          message: withoutReservedPaths(outcome.message),
          difference: inlineDifference(part),
        };
        continue;
      }
      const connectors = outcome.connectors ? partConnectors([outcome.connectors]) : null;
      compiled.set(closure.partId, { glb: outcome.glb, connectors });
      renames.set(part.reference, closure.path);
      resolved[index] = {
        kind: "custom",
        ...counted,
        partId: closure.partId,
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
      unofficialAllowlist,
      rounds,
    };
  }

  private async compileReferences(
    job: ImportJob,
    library: ImportLibrary,
    { references, infer, unofficialAllowlist }: CustomCompileRequest,
  ): Promise<{
    readonly outcomes: Map<string, Exclude<PartOutcome, { status: "need" }>>;
    readonly rounds: number;
  }> {
    const outcomes = new Map<string, Exclude<PartOutcome, { status: "need" }>>();
    let pending = [...references];
    let rounds = 0;
    while (pending.length > 0) {
      if (rounds === MAX_COMPILE_ROUNDS) {
        throw new Error(`custom part closure still growing after ${MAX_COMPILE_ROUNDS} rounds`);
      }
      rounds++;
      const output = this.compiler.compile(
        {
          lod: job.lod,
          studPrimitives: job.studPrimitives,
          unofficialAllowlist,
          connectors: {
            primitives: job.primitives,
            sectionVocabulary: job.sectionVocabulary,
            cavityProbe: job.cavityProbe,
            infer: job.primitives === null ? [] : infer,
          },
          parts: pending,
          model: job.text,
          inlineChecks: [],
        },
        library,
      );
      const needed = new Set<string>();
      pending = [];
      for (const outcome of output.parts) {
        if (outcome.status === "need") {
          outcome.paths.forEach((path) => needed.add(path));
          pending.push(outcome.reference);
        } else {
          outcomes.set(outcome.reference, outcome);
        }
      }
      await this.fetchNeeded(library, needed);
    }
    return { outcomes, rounds };
  }

  private async bakeDrawn(
    job: ImportJob,
    library: ImportLibrary,
    drawn: Uint8Array,
    { bakeSource, unofficialAllowlist }: Pick<CustomPass, "bakeSource" | "unofficialAllowlist">,
  ): Promise<BakeRounds> {
    if (!drawn.includes(1)) return { bake: null, issue: "nothing in the file is drawn", rounds: 0 };
    for (let rounds = 1; rounds <= MAX_COMPILE_ROUNDS; rounds++) {
      const outcome = this.compiler.bake(
        {
          source: bakeSource,
          drawn,
          studPrimitives: job.studPrimitives,
          unofficialAllowlist,
          translucentColors: job.translucentColors,
          vehicles: job.vehicles,
        },
        library,
      );
      switch (outcome.status) {
        case "baked": {
          const { status: _baked, ...bake } = outcome;
          return { bake, issue: null, rounds };
        }
        case "failed":
          return { bake: null, issue: withoutReservedPaths(outcome.message), rounds };
        case "need":
          await this.fetchNeeded(library, new Set(outcome.paths));
          break;
        default: {
          const unhandled: never = outcome;
          throw new Error(`unhandled bake outcome ${String(unhandled)}`);
        }
      }
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
  const matrix = read.instanceMatrix;
  const total = part.length;
  const partIndex = new Uint32Array(total);
  const ldrawColor = new Uint32Array(total);
  const matrices = new Float32Array(total * MATRIX_FLOATS);
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
    matrices.set(
      matrix.subarray(i * MATRIX_FLOATS, (i + 1) * MATRIX_FLOATS),
      drawn * MATRIX_FLOATS,
    );
    drawnMask[i] = 1;
    drawn++;
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
    compiled.push({ partId: resolved.partId, glb });
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
      compiled,
    },
  };
}

function compiledGlb(
  outcome: Exclude<PartOutcome, { status: "need" }> | undefined,
): Uint8Array | undefined {
  return outcome?.status === "compiled" ? outcome.glb : undefined;
}
