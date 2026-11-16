import { runWasiCommand } from "./wasi-command.ts";

export type CompileLod = "standard" | "low" | "far";

export interface LdrawHeader {
  readonly name: string;
  readonly title: string;
  readonly author: string;
  readonly license: string | null;
  readonly ldrawOrg: string | null;
}

export interface BakeOutput {
  readonly sections: ReadonlyArray<LdrawHeader>;
  readonly parts: ReadonlyArray<string>;
  readonly instances: {
    readonly part: ReadonlyArray<number>;
    readonly color: ReadonlyArray<number>;
    readonly matrix: ReadonlyArray<number>;
  };
  readonly inlineParts: ReadonlyArray<InlinePart>;
}

export interface InlinePart {
  readonly inline: string;
  readonly official: string;
}

export interface CompileRequest {
  readonly lod: CompileLod;
  readonly studPrimitives: ReadonlyArray<string>;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly files: Readonly<Record<string, string>>;
  readonly absent: ReadonlyArray<string>;
  readonly parts: ReadonlyArray<string>;
  readonly model: string;
  readonly inlineChecks: ReadonlyArray<InlinePart>;
}

export type FailureKind = "unresolved" | "tooDeep" | "license" | "unofficial";

export interface Failure {
  readonly status: "failed";
  readonly kind: FailureKind;
  readonly message: string;
  readonly missing?: string;
  readonly from?: string;
  readonly path?: string;
  readonly ldrawOrg?: string;
}

export interface Need {
  readonly status: "need";
  readonly paths: ReadonlyArray<string>;
}

export interface CompiledPartOutput {
  readonly status: "compiled";
  readonly file: string;
  readonly header: LdrawHeader;
  readonly files: number;
  readonly glb: Uint8Array;
}

export type PartOutcome = (CompiledPartOutput | Need | Failure) & { readonly reference: string };

export interface InlineMeasured {
  readonly status: "measured";
  readonly maxVertexDistanceLdu: number;
  readonly withinWeld: boolean;
}

export type InlineOutcome = (InlineMeasured | Need | Failure) & InlinePart;

export interface CompileOutput {
  readonly parts: ReadonlyArray<PartOutcome>;
  readonly inline: ReadonlyArray<InlineOutcome>;
  readonly weldEpsilonLdu: number;
}

interface RawCompiled {
  readonly status: "compiled";
  readonly reference: string;
  readonly offset: number;
  readonly length: number;
  readonly file: string;
  readonly header: LdrawHeader;
  readonly files: number;
}

type RawPartOutcome = RawCompiled | ((Need | Failure) & { readonly reference: string });

interface RawCompileHeader {
  readonly parts: ReadonlyArray<RawPartOutcome>;
  readonly inline: ReadonlyArray<InlineOutcome>;
  readonly weldEpsilonLdu: number;
}

const HEADER_LENGTH_BYTES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBakeOutput(value: unknown): value is BakeOutput {
  return (
    isRecord(value) &&
    Array.isArray(value["sections"]) &&
    Array.isArray(value["parts"]) &&
    isRecord(value["instances"]) &&
    Array.isArray(value["inlineParts"])
  );
}

function isCompileHeader(value: unknown): value is RawCompileHeader {
  return (
    isRecord(value) &&
    Array.isArray(value["parts"]) &&
    Array.isArray(value["inline"]) &&
    typeof value["weldEpsilonLdu"] === "number"
  );
}

export class BrickCompiler {
  constructor(private readonly module: WebAssembly.Module) {}

  private async run(request: Record<string, unknown>): Promise<Uint8Array> {
    const stdin = new TextEncoder().encode(JSON.stringify(request));
    const result = await runWasiCommand(this.module, stdin);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `brick-compile exited with ${result.exitCode}`);
    }
    return result.stdout;
  }

  async bake(source: string): Promise<BakeOutput> {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(await this.run({ op: "bake", source })),
    );
    if (!isBakeOutput(parsed)) throw new Error("brick-compile bake output is malformed");
    return parsed;
  }

  async compile(request: CompileRequest): Promise<CompileOutput> {
    const bytes = await this.run({ op: "compile", ...request });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint32(0, true);
    const blobStart = HEADER_LENGTH_BYTES + headerLength;
    const header: unknown = JSON.parse(
      new TextDecoder().decode(bytes.subarray(HEADER_LENGTH_BYTES, blobStart)),
    );
    if (!isCompileHeader(header)) throw new Error("brick-compile compile output is malformed");
    const blob = bytes.subarray(blobStart);
    return {
      weldEpsilonLdu: header.weldEpsilonLdu,
      inline: header.inline,
      parts: header.parts.map((outcome): PartOutcome => {
        if (outcome.status !== "compiled") return outcome;
        const { offset, length, ...rest } = outcome;
        return { ...rest, glb: blob.slice(offset, offset + length) };
      }),
    };
  }
}
