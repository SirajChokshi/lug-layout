import { mmRectInWorld, studsInside, type PlanRegion } from "@brr/domain";
import { Container } from "inversify";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import type { PlanSheet } from "../plan/plan-sheet.ts";
import { PDF_SHEET_WRITER, SHEET_COMPOSER } from "../tokens.ts";
import { group, rgb, type DrawItem, type Paint } from "./draw-list.ts";
import type { SheetDocument, SheetPage } from "./sheet-document.ts";
import { WHOLE_PLAN_SELECTION } from "./sheet-sets.ts";
import { textStyle } from "./sheet-paints.ts";

const container = new Container();
container.load(
  ...mainThreadModules({
    bundleBaseUrl: "unused",
    disclaimer: "Not affiliated with any brick maker.",
    startSimWorker: () => new MessageChannel().port1,
  }),
);
const writer = container.get(PDF_SHEET_WRITER);
const composer = container.get(SHEET_COMPOSER);

const POINTS_PER_MM = 72 / 25.4;
const INK: Paint = {
  fill: null,
  fillOpacity: 1,
  stroke: rgb("#000000"),
  strokeMm: 0.25,
  dashMm: [],
};

function page(items: ReadonlyArray<DrawItem>, name = "sheet"): SheetPage {
  return { name, size: { widthMm: 210, heightMm: 297 }, items };
}

function latin1(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

interface Parsed {
  readonly text: string;
  readonly objects: ReadonlyMap<number, string>;
  readonly streams: ReadonlyArray<string>;
}

function parse(bytes: Uint8Array): Parsed {
  const text = latin1(bytes);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/u.exec(text)?.[1]);
  const xref = text.slice(startxref);
  const header = /^xref\n0 (\d+)\n/u.exec(xref);
  if (!header) throw new Error("startxref doesn't point at the cross-reference table");
  const count = Number(header[1]);
  const entries = xref.slice(header[0].length).match(/^\d{10} \d{5} [fn]\r\n/gmu) ?? [];
  const objects = new Map<number, string>();
  entries.slice(1, count).forEach((entry, i) => {
    const offset = Number(entry.slice(0, 10));
    const id = i + 1;
    const end = text.indexOf("\nendobj\n", offset);
    expect(text.startsWith(`${id} 0 obj\n`, offset)).toBe(true);
    objects.set(id, text.slice(offset + `${id} 0 obj\n`.length, end));
  });
  expect(entries.length).toBe(count);
  expect(new RegExp(`/Size ${count} `, "u").test(xref)).toBe(true);
  const streams = [...objects.values()].flatMap((body) => {
    const match = /^<< \/Length (\d+) >>\nstream\n/u.exec(body);
    if (!match) return [];
    const content = body.slice(match[0].length);
    expect(content.endsWith("\nendstream")).toBe(true);
    const stream = content.slice(0, -"\nendstream".length);
    expect(stream.length).toBe(Number(match[1]));
    return [stream];
  });
  return { text, objects, streams };
}

type Matrix = readonly [number, number, number, number, number, number];

function times(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function onPage(m: Matrix, x: number, y: number): readonly [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function strokedSegments(stream: string): Array<readonly [number, number, number, number]> {
  const tokens = stream.replace(/\([^)]*\)/gu, "()").split(/\s+/u);
  const operands: number[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let path: Array<readonly [number, number]> = [];
  const segments: Array<readonly [number, number, number, number]> = [];
  for (const token of tokens) {
    const value = Number(token);
    if (token !== "" && Number.isFinite(value)) {
      operands.push(value);
      continue;
    }
    const args = operands.splice(0);
    switch (token) {
      case "q":
        stack.push(ctm);
        break;
      case "Q":
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        break;
      case "cm":
        ctm = times(
          [args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0, args[4] ?? 0, args[5] ?? 0],
          ctm,
        );
        break;
      case "m":
        path = [onPage(ctm, args[0] ?? 0, args[1] ?? 0)];
        break;
      case "l":
        path.push(onPage(ctm, args[0] ?? 0, args[1] ?? 0));
        break;
      case "S":
        for (let i = 1; i < path.length; i++) {
          const from = path[i - 1];
          const to = path[i];
          if (from && to) segments.push([from[0], from[1], to[0], to[1]]);
        }
        path = [];
        break;
      default:
        break;
    }
  }
  return segments;
}

function fileId(bytes: Uint8Array): string | undefined {
  return /\/ID \[<([0-9a-f]{32})>/u.exec(latin1(bytes))?.[1];
}

const REGION: PlanRegion = {
  id: "plan-1",
  name: "Club show (east hall)",
  originChunkX: 0,
  originChunkZ: 0,
  footprint: {
    roomWidthMm: 3000,
    roomDepthMm: 1200,
    tables: [
      {
        id: "t1",
        name: "Front",
        number: 1,
        rect: { x: 200, z: 200, width: 1234, depth: 600 },
        heightMm: 800,
      },
    ],
    obstacles: [],
  },
  maxOverhangMm: 0,
  maxReachMm: 700,
};

const SHEET: PlanSheet = {
  name: REGION.name,
  originX: 0,
  originZ: 0,
  room: mmRectInWorld(REGION, { x: 0, z: 0, width: 3000, depth: 1200 }),
  tables: REGION.footprint.tables.map((table) => ({
    id: table.id,
    name: table.name,
    number: table.number,
    heightMm: table.heightMm,
    surface: mmRectInWorld(REGION, table.rect),
    studs: studsInside(REGION, table.rect),
  })),
  obstacles: [],
  roadway: [],
  ramps: [],
  placements: [
    {
      number: 1,
      label: "my-cottage.ldr at 1000, 1000",
      parts: 13,
      segment: "model",
      rings: [
        [
          [1000, 1000],
          [1160, 1000],
          [1160, 1160],
          [1000, 1160],
        ],
      ],
      flagged: false,
    },
  ],
  partsList: { placements: 1, parts: 13, lines: 3, uncounted: 0 },
  verdict: { buildable: true, issues: 0, unmeasured: 0, notChecked: [], unchecked: null },
  disclaimer: "Not affiliated with any brick maker.",
};

describe("PdfSheetWriter", () => {
  it("writes a PDF whose cross-reference table finds every object, with exact stream lengths and one page per sheet page", async () => {
    const tiled = composer.compose(
      SHEET,
      {
        kind: "tiled",
        paper: "a4",
        orientation: "auto",
        denominator: 5,
        overlapMm: 10,
      },
      WHOLE_PLAN_SELECTION,
    );
    const file = await writer.write(tiled, "Club-show.plan-tiled-a4-1to5");
    const pdf = parse(file.bytes);
    const pageObjects = [...pdf.objects.values()].filter((body) =>
      body.startsWith("<< /Type /Page "),
    );
    expect(pdf.text.startsWith("%PDF-1.4\n")).toBe(true);
    expect({ name: file.fileName, type: file.mimeType, pages: file.pages }).toEqual({
      name: "Club-show.plan-tiled-a4-1to5.pdf",
      type: "application/pdf",
      pages: tiled.pages.length,
    });
    expect(pageObjects).toHaveLength(tiled.pages.length);
    expect(pdf.streams).toHaveLength(tiled.pages.length);
    expect(pdf.text).toContain(`/Count ${tiled.pages.length} >>`);
  });

  it("sizes each page from the paper at 72 points per inch and draws a 64 mm bar 64 mm long, through nested scales", async () => {
    const document: SheetDocument = {
      title: "Bars",
      pages: [
        page([
          { kind: "line", role: "check-bar", paint: INK, from: [10, 20], to: [74, 20] },
          group(
            "layer-track",
            [{ kind: "line", role: "track", paint: INK, from: [0, 0], to: [3200, 0] }],
            { scale: 0.02, dx: 10, dy: 40 },
          ),
        ]),
      ],
    };
    const pdf = parse((await writer.write(document, "bars")).bytes);
    const [stream] = pdf.streams;
    const lengths = strokedSegments(stream ?? "").map(([x1, y1, x2, y2]) =>
      Math.hypot(x2 - x1, y2 - y1),
    );
    const [first] = strokedSegments(stream ?? "");
    expect(pdf.text).toContain("/MediaBox [0 0 595.2756 841.8898]");
    expect(lengths.map((length) => (length / POINTS_PER_MM).toFixed(6))).toEqual([
      "64.000000",
      "64.000000",
    ]);
    expect(first?.map((value) => value.toFixed(4))).toEqual(
      [
        10 * POINTS_PER_MM,
        (297 - 20) * POINTS_PER_MM,
        74 * POINTS_PER_MM,
        (297 - 20) * POINTS_PER_MM,
      ].map((value) => value.toFixed(4)),
    );
  });

  it("places middle- and end-anchored text by Courier's fixed advance and writes it in WinAnsi, printing characters outside it as ? with a note", async () => {
    const style = textStyle(3, { anchor: "middle" });
    const file = await writer.write(
      {
        title: "Text",
        pages: [
          page([
            { kind: "text", role: "label", style, at: [100, 50], text: "1·2×3", turn: "none" },
            {
              kind: "text",
              role: "label",
              style: textStyle(4, { anchor: "end" }),
              at: [100, 60],
              text: "a(b)c\\d Ω→",
              turn: "none",
            },
          ]),
        ],
      },
      "text",
    );
    const [stream] = parse(file.bytes).streams;
    expect(stream).toContain("1 0 0 -1 95.5 50 Tm (1\\2672\\3273) Tj");
    expect(stream).toContain("1 0 0 -1 76 60 Tm (a\\(b\\)c\\\\d ??) Tj");
    expect(file.notes).toEqual([
      "2 characters aren't in the PDF's standard Courier font and print as \"?\": Ω →. The SVG sheets keep them.",
    ]);
  });

  it("names the standard Courier fonts in WinAnsi and keeps the full title in the document information", async () => {
    const pdf = parse(
      (await writer.write({ title: "Attic ⟨east⟩", pages: [page([])] }, "attic")).bytes,
    );
    const fonts = [...pdf.objects.values()].filter((body) => body.includes("/Type /Font"));
    expect(fonts).toEqual([
      "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>",
    ]);
    expect(pdf.text).toContain("/Title <FEFF00410074007400690063002027E8006500610073007427E9>");
  });

  it("writes the same bytes for the same sheets and a different file identifier for different sheets", async () => {
    const one = composer.compose(
      SHEET,
      { kind: "fit", paper: "a4", orientation: "auto" },
      WHOLE_PLAN_SELECTION,
    );
    const other = composer.compose(
      { ...SHEET, name: "Club show (west hall)" },
      { kind: "fit", paper: "a4", orientation: "auto" },
      WHOLE_PLAN_SELECTION,
    );
    const first = (await writer.write(one, "show")).bytes;
    const again = (await writer.write(one, "show")).bytes;
    expect(again).toEqual(first);
    expect(fileId(first)).toBeDefined();
    expect(fileId((await writer.write(other, "show")).bytes)).not.toBe(fileId(first));
  });

  it("never writes a non-finite number", async () => {
    await expect(
      writer.write(
        {
          title: "Broken",
          pages: [
            page([{ kind: "line", role: "track", paint: INK, from: [0, Number.NaN], to: [1, 1] }]),
          ],
        },
        "broken",
      ),
    ).rejects.toThrow(RangeError);
  });
});
