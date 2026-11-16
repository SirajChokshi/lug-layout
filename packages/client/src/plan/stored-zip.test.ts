import { describe, expect, it } from "vitest";
import { crc32, readStoredZip, storedZip } from "./stored-zip.ts";

const encoder = new TextEncoder();

describe("stored zip", () => {
  it("reads back what it writes, byte for byte, and writes the same bytes twice", () => {
    const entries = [
      { name: "manifest.json", bytes: encoder.encode('{"format":"brrplan"}\n') },
      { name: "plan.svg", bytes: encoder.encode("<svg/>") },
    ];
    const zip = storedZip(entries);
    expect(readStoredZip(zip)).toEqual(entries);
    expect(storedZip(entries)).toEqual(zip);
  });

  it("matches the standard CRC-32 check value and refuses a damaged file", () => {
    expect(crc32(encoder.encode("123456789")).toString(16)).toBe("cbf43926");
    const zip = storedZip([{ name: "a.txt", bytes: encoder.encode("abc") }]);
    const damaged = Uint8Array.from(zip);
    damaged[30 + "a.txt".length] = "x".charCodeAt(0);
    expect(() => readStoredZip(damaged)).toThrow(/CRC-32/u);
  });
});
