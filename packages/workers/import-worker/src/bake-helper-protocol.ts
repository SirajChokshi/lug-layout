import type { BakeOutcome, BakeRequest } from "@brr/import";

export interface LibraryDelta {
  readonly key: string;
  readonly files: ReadonlyArray<readonly [string, string]>;
  readonly absent: ReadonlyArray<string>;
}

export interface BakeHelperRequest {
  readonly compilerUrl: string;
  readonly request: BakeRequest;
  readonly library: LibraryDelta;
}

export type BakeHelperReply =
  | { readonly kind: "settled"; readonly outcome: BakeOutcome }
  | { readonly kind: "threw"; readonly message: string };
