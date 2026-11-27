import { readZip } from "@brr/storage/zip";
import { Container } from "inversify";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { SVG_SHEET_WRITER } from "../tokens.ts";
import { group, rgb, type DrawItem, type Paint } from "./draw-list.ts";
import type { SheetDocument, SheetPage } from "./sheet-document.ts";
import { textStyle } from "./sheet-paints.ts";

const container = new Container();
container.load(
  ...mainThreadModules({
    bundleBaseUrl: "unused",
    disclaimer: "unused",
    startSimWorker: () => new MessageChannel().port1,
  }),
);
const writer = container.get(SVG_SHEET_WRITER);

const HALF_MM: Paint = {
  fill: null,
  fillOpacity: 1,
  stroke: rgb("#112233"),
  strokeMm: 0.5,
  dashMm: [2, 1],
};

function page(name: string, items: ReadonlyArray<DrawItem>): SheetPage {
  return { name, size: { widthMm: 210, heightMm: 297 }, items };
}

describe("SvgSheetWriter", () => {
  it("sizes the page in millimetres and keeps strokes and type in paper millimetres inside scaled groups", () => {
    const svg = writer.pageSvg(
      page("A1", [
        group(
          "layer-track",
          [
            { kind: "line", role: "track", paint: HALF_MM, from: [0, 0], to: [500, 0] },
            {
              kind: "text",
              role: "label",
              style: textStyle(3),
              at: [0, 0],
              text: "x",
              turn: "none",
            },
          ],
          { scale: 0.02, dx: 10, dy: 20 },
        ),
      ]),
      "Show",
    );
    expect(svg).toContain('width="210mm" height="297mm" viewBox="0 0 210 297"');
    expect(svg).toContain('<g class="layer-track" transform="translate(10 20) scale(0.02)">');
    expect(svg).toContain('stroke="#112233" stroke-width="25" stroke-dasharray="100 50"');
    expect(svg).toMatch(/<text [^>]*font-size="150"[^>]*>x<\/text>/u);
  });

  it("clips a group to its window in the group's own coordinates", () => {
    const svg = writer.pageSvg(
      page("B2", [
        group(
          "tile",
          [{ kind: "line", role: "seam", paint: HALF_MM, from: [0, 0], to: [400, 0] }],
          { scale: 1, dx: -170, dy: 10 },
          { x: 180, y: 0, width: 190, height: 260 },
        ),
      ]),
      "Show",
    );
    const id =
      /<g class="tile" transform="translate\(-170 10\)" clip-path="url\(#([^)]+)\)">/u.exec(
        svg,
      )?.[1];
    expect(id).toBeDefined();
    expect(svg).toContain(
      `<clipPath id="${id}"><rect x="180" y="0" width="190" height="260"/></clipPath>`,
    );
  });

  it("escapes markup in names and labels and drops characters XML can't hold", () => {
    const svg = writer.pageSvg(
      page("sheet", [
        {
          kind: "text",
          role: "label",
          style: textStyle(3),
          at: [1, 2],
          text: 'my <cottage> & "shed"\u0007',
          turn: "none",
        },
      ]),
      "Attic & loft <east>",
    );
    expect(svg).toContain("<title>Attic &amp; loft &lt;east&gt;</title>");
    expect(svg).toContain(">my &lt;cottage&gt; &amp; &quot;shed&quot;</text>");
    expect(svg).not.toContain("\u0007");
  });

  it("never writes a non-finite number", () => {
    expect(() =>
      writer.pageSvg(
        page("sheet", [
          { kind: "line", role: "track", paint: HALF_MM, from: [0, Number.NaN], to: [1, 1] },
        ]),
        "Show",
      ),
    ).toThrow(RangeError);
  });

  it("writes one page as an SVG file and several as a stored ZIP of SVGs in page order", async () => {
    const one: SheetDocument = { title: "Show", pages: [page("sheet", [])] };
    const many: SheetDocument = {
      title: "Show",
      pages: [page("cover", []), page("A1", []), page("B1", [])],
    };
    const single = await writer.write(one, "Show.plan-fit-a4");
    const tiled = await writer.write(many, "Show.plan-tiled-a4-1to1");
    const zip = await readZip(tiled.bytes);
    expect({ name: single.fileName, type: single.mimeType, pages: single.pages }).toEqual({
      name: "Show.plan-fit-a4.svg",
      type: "image/svg+xml",
      pages: 1,
    });
    expect(new TextDecoder().decode(single.bytes)).toMatch(/^<\?xml[^]*<\/svg>\n$/u);
    expect({ name: tiled.fileName, type: tiled.mimeType, pages: tiled.pages }).toEqual({
      name: "Show.plan-tiled-a4-1to1.svg.zip",
      type: "application/zip",
      pages: 3,
    });
    expect(zip.ok && [...zip.value.keys()]).toEqual(["01-cover.svg", "02-A1.svg", "03-B1.svg"]);
    expect((await writer.write(many, "Show")).bytes).toEqual(
      (await writer.write(many, "Show")).bytes,
    );
  });
});
