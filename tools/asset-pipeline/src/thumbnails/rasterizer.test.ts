import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng, readPngHeader } from "./png.ts";
import {
  INHERIT_COLOR,
  renderThumbnail,
  THUMBNAIL_PX,
  type Mesh,
  type ThumbnailScene,
} from "./rasterizer.ts";

const RED = 4;
const TRANS_CLEAR = 47;
const COLORS = [
  { code: RED, rgb: "#C91A09", alpha: 255 },
  { code: TRANS_CLEAR, rgb: "#FCFCFC", alpha: 128 },
];
const HALF = 10;
const FACES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function cube(): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const normal of FACES) {
    const axis = normal.findIndex((c) => c !== 0);
    const [u, w] = [0, 1, 2].filter((a) => a !== axis);
    const base = positions.length / 3;
    for (const [su, sw] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const corner = [0, 0, 0];
      corner[axis] = (normal[axis] ?? 0) * HALF;
      corner[u ?? 0] = su * HALF;
      corner[w ?? 0] = sw * HALF;
      positions.push(...corner);
      normals.push(...normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    groups: [{ ldrawColor: INHERIT_COLOR, indices: Uint32Array.from(indices) }],
  };
}

function scene(color: number): ThumbnailScene {
  return {
    meshes: [cube()],
    count: 1,
    mesh: Uint32Array.of(0),
    color: Uint16Array.of(color),
    matrices: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0),
    box: { min: [-HALF, -HALF, -HALF], max: [HALF, HALF, HALF] },
  };
}

function pixel(rgba: Uint8Array, x: number, y: number): readonly number[] {
  const o = (y * THUMBNAIL_PX + x) * 4;
  return [...rgba.subarray(o, o + 4)];
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(png: Buffer): Uint8Array {
  const { width, height } = readPngHeader(png, "thumbnail");
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") {
      idat.push(png.subarray(at + 8, at + 8 + length));
    }
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i] ?? 0;
      const left = i >= 4 ? (out[y * stride + i - 4] ?? 0) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= 4 ? (out[(y - 1) * stride + i - 4] ?? 0) : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upLeft)][
        filter ?? 0
      ];
      out[y * stride + i] = (value + (predictor ?? 0)) % 256;
    }
  }
  return out;
}

describe("renderThumbnail", () => {
  const centre = THUMBNAIL_PX / 2;

  it("renders the same PNG bytes every time", () => {
    const first = encodePng(THUMBNAIL_PX, THUMBNAIL_PX, renderThumbnail(scene(RED), COLORS));
    const second = encodePng(THUMBNAIL_PX, THUMBNAIL_PX, renderThumbnail(scene(RED), COLORS));
    expect(first.equals(second)).toBe(true);
  });

  it("draws the item opaque in its colour on a transparent background", () => {
    const rgba = renderThumbnail(scene(RED), COLORS);
    expect(pixel(rgba, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(rgba, THUMBNAIL_PX - 1, THUMBNAIL_PX - 1)).toEqual([0, 0, 0, 0]);
    const [r = 0, g = 0, b = 0, a = 0] = pixel(rgba, centre, centre);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(3 * g);
    expect(r).toBeGreaterThan(3 * b);
  });

  it("blends the front of a translucent item over the background at its LDConfig alpha", () => {
    const [, , , a = 0] = pixel(renderThumbnail(scene(TRANS_CLEAR), COLORS), centre, centre);
    expect(a).toBe(128);
  });

  it("refuses a colour LDConfig does not define", () => {
    expect(() => renderThumbnail(scene(RED + 1), COLORS)).toThrow("LDConfig has no colour 5");
  });

  it("encodes a PNG that decodes to the rendered pixels", () => {
    const rgba = renderThumbnail(scene(RED), COLORS);
    const png = encodePng(THUMBNAIL_PX, THUMBNAIL_PX, rgba);
    expect(readPngHeader(png, "thumbnail")).toEqual({ width: THUMBNAIL_PX, height: THUMBNAIL_PX });
    expect(decodePng(png)).toEqual(rgba);
  });
});
