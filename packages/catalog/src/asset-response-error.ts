export class AssetResponseError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`GET ${url} failed with ${status}`);
  }
}
