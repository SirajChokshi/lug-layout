import { RECORD_ID_BYTES, TOKEN_BYTES, type RecordId, type Token } from "@brr/schema/layout-api";
import { hex } from "./digest.ts";

export interface IRandomSource {
  bytes(length: number): Uint8Array;
}

export class CryptoRandomSource implements IRandomSource {
  bytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
  }
}

export function newRecordId(random: IRandomSource): RecordId {
  return hex(random.bytes(RECORD_ID_BYTES));
}

export function newToken(random: IRandomSource): Token {
  const binary = String.fromCharCode(...random.bytes(TOKEN_BYTES));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
