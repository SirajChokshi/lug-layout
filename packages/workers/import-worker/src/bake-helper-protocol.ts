import type { BakeOutcome, BakeRequest } from "@brr/import";

export interface LibraryDelta {
  readonly key: string;
  readonly files: ReadonlyArray<readonly [string, string]>;
  readonly absent: ReadonlyArray<string>;
}

export interface RecordDelta {
  readonly key: string;
  readonly files: ReadonlyArray<readonly [string, Uint8Array]>;
  readonly references: ReadonlyArray<string>;
}

export interface BakeHelperRequest {
  readonly compilerUrl: string;
  readonly request: BakeRequest;
  readonly library: LibraryDelta;
  readonly records: RecordDelta | null;
}

export type BakeHelperReply =
  | { readonly kind: "settled"; readonly outcome: BakeOutcome }
  | { readonly kind: "threw"; readonly message: string };
