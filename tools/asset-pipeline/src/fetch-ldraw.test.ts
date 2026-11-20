import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verifyConnectivity } from "./fetch-ldraw.ts";

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
