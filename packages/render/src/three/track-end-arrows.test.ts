import {
  Color,
  Group,
  InstancedBufferGeometry,
  InterleavedBufferAttribute,
  Matrix3,
  Mesh,
  PerspectiveCamera,
  Scene,
  type BufferGeometry,
  type Camera,
} from "three/webgpu";
import { expect, it } from "vitest";
import type { TrackEndKind, TrackEndMarker } from "../scene-backend.ts";
import { TrackEndArrows } from "./track-end-arrows.ts";

const HEAD = 0;
const POST = 1;
const ARROW_COLORS_SRGB: Readonly<Record<TrackEndKind, number>> = {
  open: 0xffb000,
  gap: 0xe0202a,
  target: 0x1fbf4a,
};

function marker(
  xLdu: number,
  zLdu: number,
  headingRadians: number,
  kind: TrackEndKind = "open",
  yLdu = 16,
): TrackEndMarker {
  return { xLdu, yLdu, zLdu, headingRadians, kind };
}

function withMarkers(
  arrows: TrackEndArrows,
  markers: ReadonlyArray<TrackEndMarker>,
  originX = 0,
  originZ = 0,
): TrackEndArrows {
  arrows.set(markers, originX, originZ);
  return arrows;
}

function arrowMesh(arrows: TrackEndArrows): Mesh {
  const mesh = arrows.group.children[0];
  if (!(mesh instanceof Mesh)) throw new Error("no arrow mesh");
  return mesh;
}

function drawn(arrows: TrackEndArrows, camera: Camera): InstancedBufferGeometry {
  const mesh = arrowMesh(arrows);
  const { geometry, material } = mesh;
  if (Array.isArray(material) || !(geometry instanceof InstancedBufferGeometry)) {
    throw new Error("the arrow mesh draws one instanced geometry with one material");
  }
  mesh.onBeforeRender(
    null as unknown as Parameters<Mesh["onBeforeRender"]>[0],
    new Scene(),
    camera,
    geometry,
    material,
    new Group(),
  );
  return geometry;
}

function cameraLookingDownZ(x = 0, z = 0): PerspectiveCamera {
  const camera = new PerspectiveCamera(40, 1.5, 20, 100_000);
  camera.position.set(x, 50, z + 1000);
  camera.lookAt(x, 50, z);
  camera.updateMatrixWorld();
  return camera;
}

function cameraLookingAwayFromZ(): PerspectiveCamera {
  const camera = new PerspectiveCamera(40, 1.5, 20, 100_000);
  camera.position.set(0, 50, 1000);
  camera.lookAt(0, 50, 2000);
  camera.updateMatrixWorld();
  return camera;
}

function slotNames(geometry: InstancedBufferGeometry): string[] {
  const part = geometry.getAttribute("slotPart");
  const x = geometry.getAttribute("slotWorld3");
  return Array.from({ length: geometry.instanceCount }, (_, slot) => {
    const name = part.getX(slot) === HEAD ? "head" : "post";
    return `${name} at x ${x.getX(slot)}`;
  });
}

function slotBuffer(geometry: BufferGeometry): InterleavedBufferAttribute["data"] {
  const part = geometry.getAttribute("slotPart");
  if (!(part instanceof InterleavedBufferAttribute)) throw new Error("slots aren't interleaved");
  return part.data;
}

const ARROW_SLOT_FLOATS = 29;

function posedLikeMeshesInGroups(arrow: TrackEndMarker, originX: number, originZ: number) {
  const scene = new Scene();
  const ends = new Group();
  ends.matrixAutoUpdate = false;
  scene.add(ends);
  const group = new Group();
  group.matrixAutoUpdate = false;
  group.position.set(arrow.xLdu - originX, arrow.yLdu, arrow.zLdu - originZ);
  group.rotation.set(0, -arrow.headingRadians, 0);
  group.updateMatrix();
  const head = new Mesh();
  group.add(head);
  ends.add(group);
  scene.updateMatrixWorld();
  return {
    world: [...head.matrixWorld.elements].map(Math.fround),
    normal: [...new Matrix3().getNormalMatrix(head.matrixWorld).elements].map(Math.fround),
    color: [...new Color(ARROW_COLORS_SRGB[arrow.kind]).toArray()].map(Math.fround),
  };
}

function slotRecord(geometry: BufferGeometry, slot: number) {
  const read = (name: string, size: number): number[] => {
    const attribute = geometry.getAttribute(name);
    return [
      attribute.getX(slot),
      attribute.getY(slot),
      attribute.getZ(slot),
      attribute.getW(slot),
    ].slice(0, size);
  };
  return {
    world: [0, 1, 2, 3].flatMap((column) => read(`slotWorld${column}`, 4)),
    normal: [0, 1, 2].flatMap((column) => read(`slotNormal${column}`, 3)),
    color: read("slotColor", 3),
    part: geometry.getAttribute("slotPart").getX(slot),
  };
}

function bitwiseEqual(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

it("draws each arrow's head and post as their own items in depth order, so another arrow can fall between an arrow's post and its head, and leaves out arrows behind the camera", () => {
  const arrows = withMarkers(new TrackEndArrows(), [
    marker(0, 0, -Math.PI / 2),
    marker(40, -10, 0),
    marker(0, 2000, 0),
  ]);

  expect(slotNames(drawn(arrows, cameraLookingDownZ()))).toEqual([
    "post at x 0",
    "head at x 40",
    "post at x 40",
    "head at x 0",
  ]);
});

it("gives every item, after a rebase too, the world matrix, normal matrix and colour three gives a head mesh in a group posed at the marker, bit for bit", () => {
  const markers = [
    marker(0, 0, 0),
    marker(-1290, 655, Math.PI, "gap"),
    marker(9150, -12_800, (3 * Math.PI) / 2, "target"),
    marker(37, 41, 2 * Math.PI + 0.3),
    marker(640, -640, -Math.PI / 4, "gap", 96),
  ];
  const origins: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [8960, -12_800],
  ];
  const mismatches: string[] = [];
  for (const [originX, originZ] of origins) {
    for (const arrow of markers) {
      const arrows = withMarkers(new TrackEndArrows(), [arrow], originX, originZ);
      const geometry = drawn(
        arrows,
        cameraLookingDownZ(arrow.xLdu - originX, arrow.zLdu - originZ),
      );
      const expected = posedLikeMeshesInGroups(arrow, originX, originZ);
      const records = [slotRecord(geometry, 0), slotRecord(geometry, 1)];
      const parts = records.map((record) => record.part).toSorted();
      const same = records.every(
        (record) =>
          bitwiseEqual(record.world, expected.world) &&
          bitwiseEqual(record.normal, expected.normal) &&
          bitwiseEqual(record.color, expected.color),
      );
      if (geometry.instanceCount !== 2 || !same || parts[0] !== HEAD || parts[1] !== POST) {
        mismatches.push(JSON.stringify({ arrow, originX, originZ, records, expected }));
      }
    }
  }

  expect(mismatches).toEqual([]);
});

it("writes and uploads the slots a view draws, follows a rebase, a moved camera and more arrows than it had room for, and uploads nothing when no arrow is in view", () => {
  const arrows = new TrackEndArrows();
  const versions: number[] = [];
  const draws: string[][] = [];
  const pendingUploads: Array<{
    ranges: Array<{ start: number; count: number }>;
    visibleFloats: number;
  }> = [];
  const draw = (camera: Camera): void => {
    const geometry = drawn(arrows, camera);
    const slots = slotBuffer(geometry);
    draws.push(slotNames(geometry));
    versions.push(slots.version);
    pendingUploads.push({
      ranges: slots.updateRanges.map(({ start, count }) => ({ start, count })),
      visibleFloats: geometry.instanceCount * ARROW_SLOT_FLOATS,
    });
    slots.clearUpdateRanges();
  };

  withMarkers(arrows, [marker(0, 0, 0), marker(100, -10, 0)]);
  draw(cameraLookingDownZ());
  arrows.place(640, 0);
  draw(cameraLookingDownZ(-640));
  draw(cameraLookingAwayFromZ());
  withMarkers(
    arrows,
    [marker(0, 0, 0), marker(100, -10, 0), marker(200, -20, 0), marker(300, 5, 0)],
    640,
  );
  draw(cameraLookingDownZ(-540));

  expect(draws).toEqual([
    ["head at x 0", "post at x 0", "head at x 100", "post at x 100"],
    ["head at x -640", "post at x -640", "head at x -540", "post at x -540"],
    [],
    [
      "head at x -340",
      "post at x -340",
      "head at x -640",
      "post at x -640",
      "head at x -540",
      "post at x -540",
      "head at x -440",
      "post at x -440",
    ],
  ]);
  expect({
    uploadedOnChange: (versions[1] ?? 0) > (versions[0] ?? 0),
    nothingInViewUploadsNothing: versions[2] === versions[1],
    grownBufferUploaded: (versions[3] ?? 0) > 0,
  }).toEqual({
    uploadedOnChange: true,
    nothingInViewUploadsNothing: true,
    grownBufferUploaded: true,
  });
  expect([pendingUploads[0], pendingUploads[1], pendingUploads[3]]).toEqual([
    { ranges: [{ start: 0, count: 4 * ARROW_SLOT_FLOATS }], visibleFloats: 4 * ARROW_SLOT_FLOATS },
    { ranges: [{ start: 0, count: 4 * ARROW_SLOT_FLOATS }], visibleFloats: 4 * ARROW_SLOT_FLOATS },
    { ranges: [{ start: 0, count: 8 * ARROW_SLOT_FLOATS }], visibleFloats: 8 * ARROW_SLOT_FLOATS },
  ]);
});

it("refuses markers with a hole before changing anything, and keeps placing and drawing the arrows it had", () => {
  const arrows = withMarkers(new TrackEndArrows(), [marker(0, 0, 0)]);
  const holed: TrackEndMarker[] = [marker(100, 0, 0)];
  holed.length = 2;

  expect(() => arrows.set(holed, 0, 0)).toThrow("track-end marker 1 is missing");
  arrows.place(640, 0);
  expect(slotNames(drawn(arrows, cameraLookingDownZ(-640)))).toEqual([
    "head at x -640",
    "post at x -640",
  ]);
});
