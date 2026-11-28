import { describe, expect, it } from "vitest";
import { ldrawNumber } from "./ldraw-text.ts";
import {
  mpdText,
  type LdrawOriginal,
  type MpdDocument,
  type SubmodelLine,
} from "./mpd-document.ts";

const IDENTITY = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
const REFERENCE_TOKEN = 14;
const SEED = 0x5eed_1dd7;
const SAMPLES = 4000;
const UINT32_RANGE = 2 ** 32;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

function sampledDoubles(random: () => number): number[] {
  const values: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const magnitude = 10 ** Math.floor(random() * 50 - 25);
    const sign = random() < 0.5 ? -1 : 1;
    values.push(sign * random() * magnitude, sign * Math.round(random() * 1e6), sign / (i + 3));
  }
  return values;
}

function key(name: string): string {
  return name.trim().split(/\s+/u).join(" ").replaceAll("\\", "/").toLowerCase();
}

interface ReadMpd {
  readonly order: ReadonlyArray<string>;
  readonly bodies: ReadonlyMap<string, ReadonlyArray<string>>;
}

function readMpd(text: string): ReadMpd {
  const order: string[] = [];
  const bodies = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens[0] === "0" && tokens[1]?.toUpperCase() === "FILE") {
      const name = key(tokens.slice(2).join(" "));
      current = [];
      order.push(name);
      bodies.set(name, current);
      continue;
    }
    if (current === null) {
      if (line.trim() === "") continue;
      current = [];
      order.push("");
      bodies.set("", current);
    }
    current.push(line);
  }
  return { order, bodies };
}

function referenceOf(line: string): string | null {
  const tokens = line.trim().split(/\s+/u);
  return tokens[0] === "1" && tokens.length > REFERENCE_TOKEN
    ? key(tokens.slice(REFERENCE_TOKEN).join(" "))
    : null;
}

function geometryOf(body: ReadonlyArray<string>): ReadonlyArray<string> {
  return body.filter((line) => /^[2-5]\s/u.test(line.trim()));
}

type Resolved = { readonly to: "library"; readonly name: string } | { readonly to: "section" };

function resolvedTree(read: ReadMpd, from: string, trail: ReadonlyArray<string> = []): unknown {
  const body = read.bodies.get(from) ?? [];
  return {
    geometry: geometryOf(body),
    children: body.flatMap((line) => {
      const reference = referenceOf(line);
      if (reference === null) return [];
      if (!read.bodies.has(reference) || trail.includes(reference)) {
        return [{ to: "library", name: reference } satisfies Resolved];
      }
      return [resolvedTree(read, reference, [...trail, from])];
    }),
  };
}

function originalTree(original: LdrawOriginal): unknown {
  const read = readMpd(original.text);
  const [main] = read.order;
  if (main === undefined) throw new Error(`${original.name} has no sections`);
  return resolvedTree(read, main);
}

function referencesOf(read: ReadMpd, section: string): ReadonlyArray<string> {
  return (read.bodies.get(section) ?? []).flatMap((line) => {
    const reference = referenceOf(line);
    return reference === null ? [] : [reference];
  });
}

function layoutSubmodel(read: ReadMpd): string {
  const [layout] = referencesOf(read, read.order[0] ?? "");
  if (layout === undefined) throw new Error("the main model places no layout submodel");
  return layout;
}

const BRICK_LINE = "1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat";

function model(name: string, lines: ReadonlyArray<string>): string {
  return [`0 FILE ${name}`, `0 ${name}`, `0 Name: ${name}`, ...lines].join("\r\n");
}

const cottage: LdrawOriginal = {
  key: "import:cottage",
  tag: "c0ffee000001",
  name: "cottage.mpd",
  text: [
    model("cottage.ldr", [BRICK_LINE, "1 16 40 0 0 0 0 1 0 1 0 -1 0 0 wheel.ldr"]),
    model("wheel.ldr", ["1 0 0 0 0 1 0 0 0 1 0 0 0 1 3.dat", "3 1 0 0 0 1 0 0 0 0 1"]),
    model("3.dat", ["0 !LDRAW_ORG Unofficial_Part", "3 14 0 0 0 9 0 0 0 0 9"]),
    "",
  ].join("\r\n"),
};

const crane: LdrawOriginal = {
  key: "bundle:standard:crane",
  tag: "c4a1e0000002",
  name: "crane.mpd",
  text: [
    model("crane.ldr", [
      "1 7 0 0 0 1 0 0 0 1 0 0 0 1 wheel.ldr",
      "1 7 0 0 0 1 0 0 0 1 0 0 0 1 3.dat",
    ]),
    model("wheel.ldr", ["3 2 0 0 0 5 0 0 0 0 5", "1 15 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat"]),
    "",
  ].join("\n"),
};

const plainBrick: LdrawOriginal = {
  key: "import:plain",
  tag: "b41c00000003",
  name: "Layout.ldr",
  text: `${BRICK_LINE}\n1 2 0 0 0 1 0 0 0 1 0 0 0 1 layout.ldr\n`,
};

function document(originals: ReadonlyArray<LdrawOriginal>): MpdDocument {
  const lines: SubmodelLine[] = [
    { kind: "part", color: 2, affine: IDENTITY, reference: "3811.dat" },
    ...originals.map((original): SubmodelLine => ({
      kind: "model",
      affine: IDENTITY,
      original: original.key,
    })),
  ];
  return {
    name: "My show.ldr",
    title: "My show",
    notes: ["first note"],
    submodels: [{ name: "Layout.ldr", lines }],
    originals,
  };
}

describe("an LDraw number", () => {
  it("is the shortest decimal that reads back as the same double, never in exponent form", () => {
    const values = sampledDoubles(seededRandom(SEED));

    const misread = values.filter((value) => {
      const text = ldrawNumber(value);
      return Number(text) !== value || /e/iu.test(text);
    });

    expect(misread).toEqual([]);
    expect([ldrawNumber(-0), ldrawNumber(640), ldrawNumber(-24), ldrawNumber(0.5)]).toEqual([
      "0",
      "640",
      "-24",
      "0.5",
    ]);
  });

  it("is refused when it isn't finite", () => {
    expect(() => ldrawNumber(Number.NaN)).toThrow("can't be written");
    expect(() => ldrawNumber(Number.POSITIVE_INFINITY)).toThrow("can't be written");
  });
});

describe("an exported MPD", () => {
  it("embeds each file's lines unchanged and in order when no name clashes", () => {
    const text = mpdText(document([cottage]));
    const exported = text.split("\r\n");

    const original = cottage.text.split("\r\n").filter((line) => line !== "");
    const start = exported.indexOf(original[0] ?? "");
    expect(start).toBeGreaterThan(0);
    expect(exported.slice(start, start + original.length)).toEqual(original);
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("renames only the sections that clash, and every embedded file still reaches the geometry it reached on its own", () => {
    const originals = [cottage, crane, plainBrick];
    const read = readMpd(mpdText(document(originals)));
    const mains = referencesOf(read, layoutSubmodel(read));

    const exported = originals.map((original, index) => [
      original.name,
      resolvedTree(read, mains[index + 1] ?? ""),
    ]);
    const onTheirOwn = originals.map((original) => [original.name, originalTree(original)]);

    expect(mains[0]).toBe("3811.dat");
    expect(exported).toEqual(onTheirOwn);
    expect(read.bodies.has("3811.dat")).toBe(false);
    expect(read.order.filter((name) => name === "wheel.ldr")).toHaveLength(1);
    expect(read.order).toContain("cottage.ldr");
    expect(read.order).toContain("crane.ldr");
  });

  it("names the layout's own models clear of any name an embedded file refers to", () => {
    const read = readMpd(mpdText(document([plainBrick])));
    const layout = layoutSubmodel(read);
    const [, placed] = referencesOf(read, layout);

    expect(read.order[0]).toBe("my show.ldr");
    expect(layout).not.toBe("layout.ldr");
    expect(read.bodies.has("layout.ldr")).toBe(false);
    expect(resolvedTree(read, placed ?? "")).toEqual(originalTree(plainBrick));
  });

  it("writes the same text whatever order the files come in", () => {
    const forward = mpdText(document([cottage, crane, plainBrick]));
    const backward = mpdText({
      ...document([cottage, crane, plainBrick]),
      originals: [plainBrick, crane, cottage],
    });

    expect(backward).toBe(forward);
  });
});
