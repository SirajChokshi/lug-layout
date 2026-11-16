import type {
  BakeOutput,
  BrickCompiler,
  CompileLod,
  InlineOutcome,
  InlinePart,
  LdrawHeader,
  PartOutcome,
} from "./brick-compiler.ts";
import { isDirectColor } from "@brr/catalog";
import type { LdrawMirror, MirrorSource, MirrorStats } from "./ldraw-mirror.ts";
import type { StudioReport } from "./studio-import.ts";

export interface ImportJob {
  readonly fileName: string;
  readonly text: string;
  readonly lod: CompileLod;
  readonly source: MirrorSource;
  readonly studPrimitives: ReadonlyArray<string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly bundlePartIds: ReadonlyArray<string>;
  readonly ldconfigCodes: ReadonlyArray<number>;
}

interface Counted {
  readonly reference: string;
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
      readonly inline: string;
      readonly maxVertexDistanceLdu: number;
      readonly weldEpsilonLdu: number;
    })
  | (Counted & { readonly kind: "failed"; readonly message: string });

export type PartResolutionKind = PartResolution["kind"];

export interface ColorIssue {
  readonly code: number;
  readonly instances: number;
}

export interface ImportTimings {
  readonly bakeMs: number;
  readonly resolveMs: number;
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
  readonly unknownColors: ReadonlyArray<ColorIssue>;
  readonly directColors: ReadonlyArray<number>;
  readonly compileRounds: number;
  readonly fetched: MirrorStats;
  readonly timings: ImportTimings;
}

export interface CompiledGlb {
  readonly partId: string;
  readonly glb: Uint8Array;
}

export interface ImportResult {
  readonly report: ImportReport;
  readonly partIds: ReadonlyArray<string>;
  readonly instanceCount: number;
  readonly partIndex: Uint32Array;
  readonly ldrawColor: Uint32Array;
  readonly matrices: Float32Array;
  readonly compiled: ReadonlyArray<CompiledGlb>;
  readonly studio?: StudioReport;
}

const MAX_COMPILE_ROUNDS = 64;
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

export class ModelImportEngine {
  constructor(
    private readonly compiler: BrickCompiler,
    private readonly mirror: LdrawMirror,
    private readonly now: () => number,
  ) {}

  async importText(job: ImportJob): Promise<ImportResult> {
    const started = this.now();
    const baked = await this.compiler.bake(job.text);
    const bakedAt = this.now();
    const bundleIds = new Set(job.bundlePartIds);
    const outside = baked.parts.filter((reference) => !bundleIds.has(bundlePartId(reference)));
    const outcomes = await this.resolveOutside(job, outside, baked.inlineParts);
    const resolvedAt = this.now();
    const counts = instanceCounts(baked);
    const parts = baked.parts.map((reference, index) =>
      resolution(reference, counts[index] ?? 0, bundleIds, baked.inlineParts, outcomes),
    );
    return assemble(job, baked, parts, outcomes, this.mirror.stats(), {
      bakeMs: bakedAt - started,
      resolveMs: resolvedAt - bakedAt,
      totalMs: resolvedAt - started,
    });
  }

  private async resolveOutside(
    job: ImportJob,
    outside: ReadonlyArray<string>,
    inlineParts: ReadonlyArray<InlinePart>,
  ): Promise<Outcomes> {
    const files: Record<string, string> = {};
    const absent = new Set<string>();
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
      const output = await this.compiler.compile({
        lod: job.lod,
        studPrimitives: job.studPrimitives,
        unofficialAllowlist: job.unofficialAllowlist,
        files,
        absent: [...absent],
        parts: pendingParts,
        model: job.text,
        inlineChecks: pendingChecks,
      });
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
      const unknown = [...needed].filter((path) => !(path in files) && !absent.has(path));
      if (needed.size > 0 && unknown.length === 0) {
        throw new Error(`compiler keeps asking for files it already has: ${[...needed]}`);
      }
      const probe = await this.mirror.probe(unknown, FETCH_CONCURRENCY);
      for (const [path, text] of probe.found) files[path] = text;
      for (const path of probe.absent) absent.add(path);
    }
    return { parts, inline, rounds, weldEpsilonLdu };
  }
}

function instanceCounts(baked: BakeOutput): Uint32Array {
  const counts = new Uint32Array(baked.parts.length);
  for (const part of baked.instances.part) counts[part] = (counts[part] ?? 0) + 1;
  return counts;
}

function inlineMismatch(
  reference: string,
  inlineParts: ReadonlyArray<InlinePart>,
  outcomes: Outcomes,
): { inline: string; maxVertexDistanceLdu: number } | undefined {
  for (const part of inlineParts) {
    if (part.official !== reference) continue;
    const outcome = outcomes.inline.get(part.inline);
    if (outcome?.status === "measured" && !outcome.withinWeld) {
      return { inline: part.inline, maxVertexDistanceLdu: outcome.maxVertexDistanceLdu };
    }
  }
  return undefined;
}

function resolution(
  reference: string,
  instances: number,
  bundleIds: ReadonlySet<string>,
  inlineParts: ReadonlyArray<InlinePart>,
  outcomes: Outcomes,
): PartResolution {
  const mismatch = inlineMismatch(reference, inlineParts, outcomes);
  if (mismatch) {
    return {
      kind: "inlineDiffers",
      reference,
      instances,
      ...mismatch,
      weldEpsilonLdu: outcomes.weldEpsilonLdu,
    };
  }
  const partId = bundlePartId(reference);
  if (bundleIds.has(partId)) return { kind: "bundle", reference, instances, partId };
  const outcome = outcomes.parts.get(reference);
  if (!outcome) throw new Error(`no compile outcome for ${reference}`);
  switch (outcome.status) {
    case "compiled":
      return {
        kind: "compiled",
        reference,
        instances,
        partId,
        file: outcome.file,
        header: outcome.header,
        sourceFiles: outcome.files,
      };
    case "failed":
      switch (outcome.kind) {
        case "unresolved":
          if (outcome.from === "" || outcome.from === undefined) {
            return {
              kind: "notInLibrary",
              reference,
              instances,
              definedInline: inlineParts.some((part) => part.official === reference),
            };
          }
          return {
            kind: "missingSubfile",
            reference,
            instances,
            missing: outcome.missing ?? "",
            from: outcome.from,
          };
        case "license":
        case "unofficial":
          return {
            kind: "rejected",
            reference,
            instances,
            gate: outcome.kind,
            path: outcome.path ?? reference,
            message: outcome.message,
          };
        case "tooDeep":
          return { kind: "failed", reference, instances, message: outcome.message };
        default: {
          const unhandled: never = outcome.kind;
          throw new Error(`unhandled failure ${String(unhandled)}`);
        }
      }
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled outcome ${String(unhandled)}`);
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
  baked: BakeOutput,
  parts: ReadonlyArray<PartResolution>,
  outcomes: Outcomes,
  fetched: MirrorStats,
  timings: ImportTimings,
): ImportResult {
  const ldconfig = new Set(job.ldconfigCodes);
  const unknownColors = new Map<number, number>();
  const directColors = new Set<number>();
  const localIndex = new Map<number, number>();
  const partIds: string[] = [];
  const { part, color, matrix } = baked.instances;
  const total = part.length;
  const partIndex = new Uint32Array(total);
  const ldrawColor = new Uint32Array(total);
  const matrices = new Float32Array(total * MATRIX_FLOATS);
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
    let local = localIndex.get(source);
    if (local === undefined) {
      local = partIds.length;
      localIndex.set(source, local);
      partIds.push(resolved.partId);
    }
    partIndex[drawn] = local;
    ldrawColor[drawn] = code;
    for (let k = 0; k < MATRIX_FLOATS; k++) {
      matrices[drawn * MATRIX_FLOATS + k] = matrix[i * MATRIX_FLOATS + k] ?? 0;
    }
    drawn++;
  }
  const compiled: CompiledGlb[] = [];
  for (const resolved of parts) {
    if (resolved.kind !== "compiled" || !localIndex.has(baked.parts.indexOf(resolved.reference))) {
      continue;
    }
    const outcome = outcomes.parts.get(resolved.reference);
    if (outcome?.status === "compiled")
      compiled.push({ partId: resolved.partId, glb: outcome.glb });
  }
  return {
    report: {
      fileName: job.fileName,
      mirror: job.source,
      lod: job.lod,
      sections: baked.sections,
      instanceCount: total,
      drawnInstanceCount: drawn,
      parts,
      inlineParts: baked.inlineParts,
      unknownColors: [...unknownColors].map(([code, instances]) => ({ code, instances })),
      directColors: [...directColors],
      compileRounds: outcomes.rounds,
      fetched,
      timings,
    },
    partIds,
    instanceCount: drawn,
    partIndex: partIndex.slice(0, drawn),
    ldrawColor: ldrawColor.slice(0, drawn),
    matrices: matrices.slice(0, drawn * MATRIX_FLOATS),
    compiled,
  };
}
