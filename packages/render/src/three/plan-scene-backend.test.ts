import { INHERIT_COLOR, type PartAsset, type StudPrimitiveAsset } from "@brr/catalog";
import { CHUNK_LDU } from "@brr/math";
import type { PlanGlyph } from "@brr/schema/bundle";
import {
  Color,
  LineSegments,
  Mesh,
  SRGBColorSpace,
  type InstancedBufferGeometry,
} from "three/webgpu";
import { describe, expect, it } from "vitest";
import { PLAN_POSE_FLOATS, type PlanInstances } from "../plan-scene.ts";
import type { ChunkInstances, PartPalette, WorldBox } from "../scene-backend.ts";
import { ThreeSceneBackend } from "./three-scene-backend.ts";

const RED = 4;
const BLUE = 1;
const CLEAR_BLUE = 43;
const RED_SRGB = 0xc91a09;
const BLUE_SRGB = 0x0055bf;
const CLEAR_BLUE_SRGB = 0xaefeff;
const CLEAR_ALPHA = 128;
const SAMPLES = 16;
const ZOOMED_IN_PX = 40;
const STUD_TOP_LDU = 4;
const STUD_RADIUS_LDU = 6;
const UPRIGHT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const ON_ITS_SIDE = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0];
const BATCH_LDU = 8 * CHUNK_LDU;

function glyph(colors: ReadonlyArray<number>, pixels: ReadonlyArray<[number, number]>): PlanGlyph {
  return {
    pixelsPerStud: 8,
    samplesPerPixelSide: 4,
    originX: -1,
    originZ: 0,
    width: pixels.length,
    depth: 1,
    colors: Uint32Array.from(colors),
    coverage: Uint8Array.from(pixels, ([covered]) => covered),
    colorIndex: Uint16Array.from(pixels, ([, index]) => index),
    loopStarts: new Uint32Array(1),
    vertices: new Uint16Array(0),
  };
}

function studPrimitive(): StudPrimitiveAsset {
  return {
    mesh: {
      positions: Float32Array.of(STUD_RADIUS_LDU, 0, 0, 0, STUD_TOP_LDU, STUD_RADIUS_LDU, 0, 0, 0),
      normals: new Float32Array(9),
      indices: Uint32Array.of(0, 1, 2),
    },
  };
}

function trackPart(): PartAsset {
  return {
    id: "track",
    title: "track",
    role: "track",
    boundsMin: [-20, 0, -20],
    boundsMax: [20, 8, 20],
    producedColor: undefined,
    producedColors: undefined,
    trackEnds: undefined,
    mesh: { positions: new Float32Array(0), normals: new Float32Array(0), groups: [] },
    studPrimitiveIndex: new Uint8Array(0),
    studColors: new Uint16Array(0),
    studMatrices: new Float32Array(0),
    technic: null,
    rolling: null,
    topSurface: null,
    outline: null,
  };
}

function palette(): PartPalette {
  return {
    detailed: { parts: [trackPart()], studPrimitives: [studPrimitive()] },
    colorsSrgb: Uint8Array.of(0xc9, 0x1a, 0x09),
    colorsAlpha: Uint8Array.of(255),
    ldrawColors: new Map([
      [RED, { srgb: RED_SRGB, alpha: 255 }],
      [BLUE, { srgb: BLUE_SRGB, alpha: 255 }],
      [CLEAR_BLUE, { srgb: CLEAR_BLUE_SRGB, alpha: CLEAR_ALPHA }],
    ]),
  };
}

function placements(originX: number, originZ: number, sprite: number): PlanInstances {
  const pose = new Float32Array(PLAN_POSE_FLOATS);
  pose.set([10, 10, 8, 1]);
  return { originX, originZ, count: 1, sprite: Uint32Array.of(sprite), pose };
}

function chunkWithStuds(originX: number, studMatrices: ReadonlyArray<number>): ChunkInstances {
  const count = studMatrices.length / 12;
  return {
    originX,
    originZ: 0,
    count: 1,
    partIndex: Uint16Array.of(0),
    colorIndex: Uint16Array.of(0),
    matrices: Float32Array.from(UPRIGHT),
    studs: {
      count,
      primitiveIndex: new Uint8Array(count),
      colorIndex: new Uint16Array(count),
      matrices: Float32Array.from(studMatrices),
    },
  };
}

function markerBox(minX: number): WorldBox {
  return { minX, minY: 0, minZ: 0, maxX: minX + 4, maxY: 3, maxZ: 20 };
}

function backendWithPalette(): ThreeSceneBackend {
  const backend = new ThreeSceneBackend();
  backend.setPalette(palette());
  return backend;
}

function meshesOf(backend: ThreeSceneBackend): ReadonlyArray<Mesh | LineSegments> {
  return backend.plan.root.children.flatMap((batch) =>
    batch.children.filter((child) => child instanceof Mesh || child instanceof LineSegments),
  );
}

function premultiplied(srgb: number, alpha: number): ReadonlyArray<number> {
  const color = new Color().setHex(srgb, SRGBColorSpace);
  return [color.r, color.g, color.b, 1].map((channel) => Math.round(channel * alpha * 255));
}

describe("the plan scene", () => {
  it("writes a glyph's pixels into the atlas with colour 16 in the placement's colour and coverage as premultiplied alpha, whenever the palette arrives", () => {
    const backend = new ThreeSceneBackend();
    backend.plan.setSprite(0, {
      glyph: glyph(
        [BLUE, INHERIT_COLOR, CLEAR_BLUE],
        [
          [SAMPLES, 1],
          [SAMPLES / 2, 0],
          [0, 0],
          [SAMPLES, 2],
        ],
      ),
      inheritedColor: RED,
      shiftX: 0,
      shiftZ: 0,
    });
    backend.setPalette(palette());
    backend.plan.prepare(1);
    const page = backend.plan["atlas"].pages[0];
    const slot = backend.plan["slots"][0];
    if (!page || !slot) throw new Error("the glyph has no atlas slot");
    const texels = Array.from({ length: 4 }, (_, column) => {
      const at = (slot.texelY * 4096 + slot.texelX + column) * 4;
      return Array.from(page.data.subarray(at, at + 4));
    });

    expect({ texels, box: [slot.minX, slot.minZ, slot.maxX, slot.maxZ] }).toEqual({
      texels: [
        premultiplied(RED_SRGB, 1),
        premultiplied(BLUE_SRGB, 0.5),
        [0, 0, 0, 0],
        premultiplied(CLEAR_BLUE_SRGB, CLEAR_ALPHA / 255),
      ],
      box: [-2.5, 0, 7.5, 2.5],
    });
  });

  it("draws every placement in an 8 × 8 chunk area with one sprite draw, and drops the area once it's empty", () => {
    const backend = backendWithPalette();
    backend.plan.setSprite(0, {
      glyph: glyph([BLUE], [[SAMPLES, 0]]),
      inheritedColor: RED,
      shiftX: 0,
      shiftZ: 0,
    });
    for (let chunk = 0; chunk < 8; chunk++) {
      backend.plan.setPlacements(chunk, placements(chunk * CHUNK_LDU, 7 * CHUNK_LDU, 0));
    }
    backend.plan.setPlacements(8, placements(BATCH_LDU, 0, 0));
    backend.plan.prepare(1);
    const drawn = meshesOf(backend).map(
      (mesh) => (mesh.geometry as InstancedBufferGeometry).instanceCount,
    );
    for (let chunk = 0; chunk <= 8; chunk++) backend.plan.deletePlacements(chunk);
    backend.plan.prepare(1);

    expect({ drawn, afterDelete: meshesOf(backend).length }).toEqual({
      drawn: [8, 1],
      afterDelete: 0,
    });
  });

  it("dots only the studs that stand upright, at their tops, once studs are big enough to see", () => {
    const backend = backendWithPalette();
    const upright = [...UPRIGHT];
    upright[3] = 30;
    upright[7] = 8;
    upright[11] = 50;
    backend.setChunk(3, chunkWithStuds(CHUNK_LDU, [...upright, ...ON_ITS_SIDE]));
    backend.plan.prepare(1);
    const hiddenWhileSmall = meshesOf(backend).map((mesh) => mesh.visible);
    backend.plan.prepare(ZOOMED_IN_PX);
    const [dots] = meshesOf(backend);
    const geometry = dots?.geometry as InstancedBufferGeometry | undefined;

    expect({
      hiddenWhileSmall,
      shown: dots?.visible,
      count: geometry?.instanceCount,
      centre: Array.from(geometry?.getAttribute("dotCentre").array ?? []),
    }).toEqual({
      hiddenWhileSmall: [false],
      shown: true,
      count: 1,
      centre: [CHUNK_LDU + 30, 8 + STUD_TOP_LDU, 50, STUD_RADIUS_LDU],
    });
  });

  it("draws every edge marker as one instanced draw, at its box's top in its kind's colour, once studs are big enough to see", () => {
    const backend = backendWithPalette();
    backend.setMarkers([
      { box: markerBox(0), kind: "joined" },
      { box: markerBox(20), kind: "open" },
      { box: markerBox(40), kind: "mismatch" },
    ]);
    const [markers] = backend.plan.root.children;
    backend.plan.prepare(1);
    const hiddenWhileSmall = markers?.visible;
    backend.plan.prepare(ZOOMED_IN_PX);
    const meshes = markers?.children ?? [];
    const geometry = (meshes[0] as Mesh | undefined)?.geometry as InstancedBufferGeometry;
    const colors = Array.from(geometry.getAttribute("markerColor").array);
    const kindColors = [0x1fbf4a, 0xffb000, 0xe0202a].flatMap((srgb) => [
      ...new Color(srgb).toArray(),
      3,
    ]);

    expect({
      hiddenWhileSmall,
      shown: markers?.visible,
      draws: meshes.length,
      count: geometry.instanceCount,
      colors,
    }).toEqual({
      hiddenWhileSmall: false,
      shown: true,
      draws: 1,
      count: 3,
      colors: Array.from(Float32Array.from(kindColors)),
    });
  });

  it("outlines a part with plan lines wherever a chunk places it, in the part's own pose", () => {
    const backend = backendWithPalette();
    backend.plan.setPartLines(0, {
      topY: 8,
      outline: Float32Array.of(0, 0, 20, 0),
      centre: new Float32Array(0),
    });
    const quarterTurn = [0, 0, 1, 100, 0, 1, 0, 0, -1, 0, 0, 200];
    backend.setChunk(5, { ...chunkWithStuds(0, []), matrices: Float32Array.from(quarterTurn) });
    backend.plan.prepare(1);
    const [outline] = meshesOf(backend);

    expect(Array.from(outline?.geometry.getAttribute("position").array ?? [])).toEqual([
      100, 8, 200, 100, 8, 180,
    ]);
  });
});
