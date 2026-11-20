import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { OmrErratum, PaletteModel } from "@brr/schema/bundle";
import { verifyConnectivity, verifyOmrErrata } from "./fetch-ldraw.ts";

const SOURCE = {
  kind: "github-mirror",
  repo: "shadow/library",
  commit: "pinned",
  root: "",
} as const;
const INCLUDER = "parts/includer.dat";
const INCLUDER_TEXT = "0 !LDCAD SNAP_INCL [ref=Target.dat]\n";

const directory = mkdtempSync(join(tmpdir(), "connectivity-"));
mkdirSync(join(directory, "parts"), { recursive: true });
writeFileSync(join(directory, INCLUDER), INCLUDER_TEXT);
const pinned = {
  source: SOURCE,
  files: { [INCLUDER]: createHash("sha256").update(INCLUDER_TEXT).digest("hex") },
};

const STATION_FILE = "station.mpd";
const STATION_TEXT =
  "0 FILE station.ldr\r\n1 7 460 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT\r\n1 7 470 0 -140 -1 0 0 0 1 0 0 0 -1 3020.DAT\r\n";
const STATION_SHA256 = createHash("sha256").update(STATION_TEXT).digest("hex");
writeFileSync(join(directory, STATION_FILE), STATION_TEXT);
const roots = { omr: directory, generated: directory };

function station(sha256: string): PaletteModel {
  return {
    name: "station",
    origin: "omr",
    file: STATION_FILE,
    sha256,
    source: "omr",
    retrieved: "now",
  };
}

const plate: OmrErratum = {
  model: "station",
  file: STATION_FILE,
  sha256: STATION_SHA256,
  line: 2,
  from: "1 7 460 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT",
  to: "1 7 470 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT",
  evidence: {
    kind: "mirror-twin",
    twin: { line: 3, text: "1 7 470 0 -140 -1 0 0 0 1 0 0 0 -1 3020.DAT" },
    summary: "mirrored pair",
  },
};

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("verifyConnectivity", () => {
  it("fails when a pinned shadow file includes a target the pinned closure leaves out", async () => {
    expect(await verifyConnectivity(pinned, SOURCE, directory, { [INCLUDER]: "" })).toEqual([
      `${INCLUDER} includes target.dat, which the pinned closure leaves out; run fetch-ldraw`,
    ]);
  });

  it("passes once the target is in the pinned closure", async () => {
    expect(
      await verifyConnectivity(pinned, SOURCE, directory, {
        [INCLUDER]: "",
        "parts/target.dat": "",
      }),
    ).toEqual([]);
  });
});

describe("verifyOmrErrata", () => {
  it("passes an erratum whose pin, line and evidence all read as recorded in the restored file", async () => {
    expect(await verifyOmrErrata({ errata: [plate] }, [station(STATION_SHA256)], roots)).toEqual(
      [],
    );
  });

  it("fails an erratum once its model is re-pinned, its evidence no longer reads as recorded, or it names no OMR model", async () => {
    const repinned = "f".repeat(64);
    const staleTwin: OmrErratum = {
      ...plate,
      evidence: {
        kind: "mirror-twin",
        twin: { line: 1, text: "1 7 470 0 -140" },
        summary: "mirrored pair",
      },
    };
    expect(
      await verifyOmrErrata(
        { errata: [plate, staleTwin, { ...plate, model: "garage" }] },
        [station(repinned)],
        roots,
      ),
    ).toEqual([
      `erratum for station line 2 pins ${STATION_FILE} ${STATION_SHA256}, but the palette pins ${STATION_FILE} ${repinned}; re-check it against the new file`,
      `erratum for station line 2 pins ${STATION_FILE} ${STATION_SHA256}, but the palette pins ${STATION_FILE} ${repinned}; re-check it against the new file`,
      "erratum for garage line 2: no OMR model garage in the palette",
    ]);
    expect(
      await verifyOmrErrata({ errata: [staleTwin] }, [station(STATION_SHA256)], roots),
    ).toEqual([
      'erratum for station line 2: line 1 reads "0 FILE station.ldr", not "1 7 470 0 -140"',
    ]);
  });
});
