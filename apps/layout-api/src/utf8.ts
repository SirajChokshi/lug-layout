import type { Decoded } from "@brr/schema/decode";

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(text));
}

export function strictUtf8Text(bytes: Uint8Array<ArrayBuffer>, path: string): Decoded<string> {
  try {
    return { ok: true, value: strictDecoder.decode(bytes) };
  } catch {
    return { ok: false, issues: [{ path, message: "is not UTF-8 text" }] };
  }
}
