import { inject, injectable } from "inversify";
import { SHEET_TYPEFACE, SVG_SHEET_WRITER } from "../tokens.ts";
import { DrawBounds } from "./draw-bounds.ts";
import { group, IDENTITY, translation, type Box } from "./draw-list.ts";
import type { PageSize } from "./paper.ts";
import {
  IMAGE_PIXELS_PER_MM,
  packedSheetFile,
  type ISheetWriter,
  type SheetDocument,
  type SheetEntry,
  type SheetFile,
  type SheetPage,
} from "./sheet-document.ts";
import { plural } from "./sheet-blocks.ts";
import { PAINTS } from "./sheet-paints.ts";
import type { ISheetTypeface } from "./sheet-typeface.ts";
import type { ISvgSheetWriter } from "./svg-sheet-writer.ts";
import { TileGrid } from "./tile-grid.ts";

const MAX_TILE_PX = 4096;

function pixels(mm: number): number {
  return mm * IMAGE_PIXELS_PER_MM;
}

function tilesAlong(mm: number): { readonly count: number; readonly px: number } {
  const total = Math.ceil(pixels(mm));
  const count = Math.ceil(total / MAX_TILE_PX);
  return { count, px: Math.ceil(total / count) };
}

function pixelGrid(size: PageSize): TileGrid {
  const across = tilesAlong(size.widthMm);
  const down = tilesAlong(size.heightMm);
  return new TileGrid(
    across.count,
    down.count,
    { widthMm: across.px / IMAGE_PIXELS_PER_MM, heightMm: down.px / IMAGE_PIXELS_PER_MM },
    0,
    [0, 0],
  );
}

function tilingNote(name: string, grid: TileGrid): string {
  const { widthMm, heightMm } = grid.windowSize;
  return `Page ${name} is split into ${plural(grid.columns, "column", "columns")} and ${plural(grid.rows, "row", "rows")} of ${pixels(widthMm)} × ${pixels(heightMm)} px tiles, ${name}-A1 to ${name}-${grid.name(grid.columns - 1, grid.rows - 1)}, so no tile is over ${MAX_TILE_PX} px a side.`;
}

async function rasterized(svg: string): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("this browser has no 2D canvas to draw a PNG on");
    context.drawImage(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

@injectable()
export class PngSheetWriter implements ISheetWriter {
  private readonly bounds: DrawBounds;

  constructor(
    @inject(SHEET_TYPEFACE) typeface: ISheetTypeface,
    @inject(SVG_SHEET_WRITER) private readonly svg: ISvgSheetWriter,
  ) {
    this.bounds = new DrawBounds(typeface);
  }

  async write(document: SheetDocument, baseName: string): Promise<SheetFile> {
    const entries: SheetEntry[] = [];
    const notes: string[] = [];
    for (const page of document.pages) {
      const grid = pixelGrid(page.size);
      if (grid.count > 1) notes.push(tilingNote(page.name, grid));
      for (let row = 0; row < grid.rows; row++) {
        for (let column = 0; column < grid.columns; column++) {
          const tile = this.tile(page, grid.window(column, row));
          const svg = this.svg.pageSvg(tile, document.title, IMAGE_PIXELS_PER_MM);
          entries.push({
            name: grid.count === 1 ? page.name : `${page.name}-${grid.name(column, row)}`,
            bytes: await rasterized(svg),
          });
        }
      }
    }
    return packedSheetFile(baseName, "png", "image/png", entries, document.pages.length, notes);
  }

  private tile(page: SheetPage, window: Box): SheetPage {
    return {
      name: page.name,
      size: { widthMm: window.width, heightMm: window.height },
      items: [
        {
          kind: "rect",
          role: "page",
          paint: PAINTS.page,
          box: { x: 0, y: 0, width: window.width, height: window.height },
        },
        group(
          "tile",
          this.bounds.culled(page.items, IDENTITY, window),
          translation(-window.x, -window.y),
        ),
      ],
    };
  }
}
