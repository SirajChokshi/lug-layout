import { describe, expect, it } from "vitest";
import { crc32, readZip, writeStoredZip } from "./zip.ts";

const utf8 = new TextEncoder();

describe("zip", () => {
  it("computes the standard CRC-32 check value", () => {
    expect(crc32(utf8.encode("123456789"))).toBe(0xcbf43926);
  });

  it("reads back what it writes, and writes the same bytes for the same entries", async () => {
    const entries = [
      { name: "manifest.json", bytes: utf8.encode('{"name":"Ville ®"}\n') },
      { name: "shards/-3907_3906.json", bytes: utf8.encode("{}\n") },
      { name: "CREDITS.txt", bytes: new Uint8Array() },
    ];
    const archive = writeStoredZip(entries);
    const read = await readZip(archive);

    expect(read.ok && [...read.value].map(([name, bytes]) => [name, [...bytes]])).toEqual(
      entries.map((entry) => [entry.name, [...entry.bytes]]),
    );
    expect(writeStoredZip(entries)).toEqual(archive);
  });

  it("refuses a damaged entry instead of returning its bytes", async () => {
    const archive = writeStoredZip([{ name: "a.json", bytes: utf8.encode("[1,2,3]") }]);
    const firstDataByte = 30 + "a.json".length;
    archive[firstDataByte] = (archive[firstDataByte] ?? 0) ^ 0xff;

    const read = await readZip(archive);

    expect(read.ok).toBe(false);
  });

  it("refuses bytes that are not a ZIP file", async () => {
    expect((await readZip(utf8.encode("not a zip"))).ok).toBe(false);
  });
});
