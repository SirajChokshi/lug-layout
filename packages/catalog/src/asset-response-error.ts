export class AssetResponseError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`GET ${url} failed with ${status}`);
  }
}
