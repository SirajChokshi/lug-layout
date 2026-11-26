const MS_PER_S = 1000;

export class AssetStalledError extends Error {
  constructor(
    readonly url: string,
    readonly silenceLimitMs: number,
  ) {
    super(`GET ${url} sent nothing for ${silenceLimitMs / MS_PER_S} s`);
  }
}
