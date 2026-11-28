import { utf8Bytes } from "./utf8.ts";

const HEX_RADIX = 16;
const HEX_BYTE_DIGITS = 2;

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_DIGITS, "0")).join(
    "",
  );
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function textSha256(text: string): Promise<string> {
  return sha256Hex(utf8Bytes(text));
}
