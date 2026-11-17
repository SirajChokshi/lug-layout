import type { OmrErrata, OmrErratum, Palette } from "@brr/schema/bundle";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { verifyOmrErrata } from "./fetch-ldraw.ts";

const MODEL =
  "0 FILE station.ldr\r\n1 7 460 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT\r\n1 7 470 0 -140 -1 0 0 0 1 0 0 0 -1 3020.DAT\r\n";
const PINNED = createHash("sha256").update(MODEL).digest("hex");
const source = {
  kind: "github-mirror" as const,
  repo: "owner/repo",
  commit: "abc",
  root: "models",
};

let omr = "";

beforeEach(async () => {
  omr = await mkdtemp(join(tmpdir(), "omr-errata-"));
  await writeFile(join(omr, "station.mpd"), MODEL);
});

afterEach(async () => {
  await rm(omr, { recursive: true, force: true });
});

function palette(sha256: string): Palette {
  return {
    source,
    config: [],
    studPrimitives: [],
    unofficialAllowlist: [],
    parts: [],
    omrSource: source,
    models: [
      {
        name: "station",
        origin: "omr",
        file: "station.mpd",
        sha256,
        source: "omr",
        retrieved: "now",
      },
    ],
    vehicleParts: { bogiePivots: [], pivotPins: [], wheelsets: [], wheels: [], couplers: [] },
    audit: [],
    connectivitySource: source,
  };
}

const plate: OmrErratum = {
  model: "station",
  file: "station.mpd",
  sha256: PINNED,
  line: 2,
  from: "1 7 460 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT",
  to: "1 7 470 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT",
  evidence: {
    kind: "mirror-twin",
    twin: { line: 3, text: "1 7 470 0 -140 -1 0 0 0 1 0 0 0 -1 3020.DAT" },
    summary: "mirrored pair",
    instructions: null,
  },
};

function check(errata: ReadonlyArray<OmrErratum>, pinned = PINNED): Promise<string[]> {
  const file: OmrErrata = { errata: [...errata] };
  return verifyOmrErrata(file, palette(pinned), { omr, generated: omr });
}

it("accepts an erratum whose pin, line and evidence all match the restored file", async () => {
  expect(await check([plate])).toEqual([]);
});

it("refuses errata once the model is re-pinned, edited, or its evidence no longer reads as recorded", async () => {
  const repinned = "f".repeat(64);
  expect(await check([plate], repinned)).toEqual([
    `erratum for station line 2 pins station.mpd ${PINNED}, but the palette pins station.mpd ${repinned}; re-check it against the new file`,
  ]);
  await writeFile(join(omr, "station.mpd"), MODEL.replace("460", "470"));
  expect(await check([plate])).toEqual([
    `erratum for station line 2: station.mpd no longer hashes to ${PINNED}`,
  ]);
  await writeFile(join(omr, "station.mpd"), MODEL);
  const staleTwin = { ...plate, evidence: { ...plate.evidence, twin: { line: 1, text: "x" } } };
  expect(await check([staleTwin, { ...plate, model: "garage" }])).toEqual([
    'erratum for station line 2: line 1 reads "0 FILE station.ldr", not "x"',
    "erratum for garage line 2: no OMR model garage in the palette",
  ]);
});
