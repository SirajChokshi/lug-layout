import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { restoreFiles, verifyConnectivity } from "./fetch-ldraw.ts";
import { DOWNLOAD_RETRY, type RetryingFetch } from "./fetch-retry.ts";

const SOURCE = {
  kind: "github-mirror",
  repo: "shadow/library",
  commit: "pinned",
  root: "",
} as const;
const INCLUDER = "parts/includer.dat";
const INCLUDER_TEXT = "0 !LDCAD SNAP_INCL [ref=Target.dat]\n";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const directory = mkdtempSync(join(tmpdir(), "connectivity-"));
mkdirSync(join(directory, "parts"), { recursive: true });
writeFileSync(join(directory, INCLUDER), INCLUDER_TEXT);
const pinned = {
  source: SOURCE,
  files: { [INCLUDER]: sha256(INCLUDER_TEXT) },
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

const PRESENT = "parts/3001.dat";
const PRESENT_TEXT = "0 Brick 2 x 4\n";
const MISSING = "parts/3003.dat";
const MISSING_TEXT = "0 Brick 2 x 2\n";
const UNPINNED = "parts/3002.dat";
const LOCK = { [PRESENT]: sha256(PRESENT_TEXT), [MISSING]: sha256(MISSING_TEXT) };
const NOT_FOUND = 404;

function rawUrl(path: string): string {
  return `https://raw.githubusercontent.com/${SOURCE.repo}/${SOURCE.commit}/${path}`;
}

function serving(answers: Readonly<Record<string, ReadonlyArray<number | string>>>) {
  const requested: string[] = [];
  const sleeps: number[] = [];
  const network: RetryingFetch = {
    fetch: async (url) => {
      const script = answers[url] ?? [];
      const served = requested.filter((seen) => seen === url).length;
      const answer = script[Math.min(served, script.length - 1)];
      requested.push(url);
      if (typeof answer === "string") return new Response(answer);
      return new Response(null, { status: answer ?? NOT_FOUND });
    },
    clock: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      now: () => 0,
    },
    policy: DOWNLOAD_RETRY,
    log: () => {},
  };
  return { network, requested, sleeps };
}

describe("restoreFiles", () => {
  const restored: string[] = [];

  function cacheDirectory(): string {
    const cache = mkdtempSync(join(tmpdir(), "restore-"));
    restored.push(cache);
    mkdirSync(join(cache, "parts"), { recursive: true });
    writeFileSync(join(cache, PRESENT), PRESENT_TEXT);
    writeFileSync(join(cache, UNPINNED), "0 Brick 2 x 3\n");
    return cache;
  }

  afterEach(() => {
    for (const cache of restored.splice(0)) rmSync(cache, { recursive: true, force: true });
  });

  it("downloads a pinned file through a 503 and checks its hash, keeps a pinned file already present, and prunes an unpinned one", async () => {
    const cache = cacheDirectory();
    const upstream = serving({ [rawUrl(MISSING)]: [503, MISSING_TEXT] });

    const result = await restoreFiles(SOURCE, LOCK, cache, upstream.network);

    expect({
      result,
      requested: upstream.requested,
      sleeps: upstream.sleeps,
      restored: readFileSync(join(cache, MISSING), "utf8"),
      unpinnedKept: existsSync(join(cache, UNPINNED)),
    }).toEqual({
      result: { present: 1, downloaded: 1, pruned: 1 },
      requested: [rawUrl(MISSING), rawUrl(MISSING)],
      sleeps: [1000],
      restored: MISSING_TEXT,
      unpinnedKept: false,
    });
  });

  it.each([
    {
      upstream: "answers 404",
      answers: [404, MISSING_TEXT],
      error: `pinned file ${MISSING} is missing from ${SOURCE.repo}@${SOURCE.commit}`,
    },
    {
      upstream: "serves bytes that don't match the pin",
      answers: ["0 Brick 1 x 2\n", MISSING_TEXT],
      error: `hash mismatch ${MISSING} from ${SOURCE.repo}`,
    },
  ])(
    "fails at once, without retrying or writing the file, when upstream $upstream",
    async ({ answers, error }) => {
      const cache = cacheDirectory();
      const upstream = serving({ [rawUrl(MISSING)]: answers });

      await expect(restoreFiles(SOURCE, LOCK, cache, upstream.network)).rejects.toThrow(error);
      expect({
        requested: upstream.requested,
        sleeps: upstream.sleeps,
        written: existsSync(join(cache, MISSING)),
      }).toEqual({ requested: [rawUrl(MISSING)], sleeps: [], written: false });
    },
  );
});
