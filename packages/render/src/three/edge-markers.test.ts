import {
  BoxGeometry,
  Color,
  Group,
  InstancedBufferGeometry,
  InterleavedBufferAttribute,
  LineSegments,
  Matrix3,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  StandardDrawingPipeline,
  type BufferGeometry,
  type Camera,
  type Object3D,
} from "three/webgpu";
import { expect, it } from "vitest";
import type { EdgeMarker, MarkerKind, WorldBox } from "../scene-backend.ts";
import { EdgeMarkers } from "./edge-markers.ts";
import { GROUND_RENDER_ORDER, SELECTION_RENDER_ORDER } from "./render-orders.ts";
import { opaqueSort, type RenderSortKey } from "./tie-order.ts";
import { TrackEndArrows } from "./track-end-arrows.ts";

const MARKER_COLORS_SRGB: Readonly<Record<MarkerKind, number>> = {
  joined: 0x1fbf4a,
  open: 0xffb000,
  mismatch: 0xe0202a,
};

const OVERLAY_SLOT_FLOATS = 28;

function box(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  minY = 9,
  maxY = 11,
): WorldBox {
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function marker(kind: MarkerKind, at: WorldBox): EdgeMarker {
  return { kind, box: at };
}

function withMarkers(
  edgeMarkers: EdgeMarkers,
  markers: ReadonlyArray<EdgeMarker>,
  originX = 0,
  originZ = 0,
): EdgeMarkers {
  edgeMarkers.set(markers, originX, originZ);
  return edgeMarkers;
}

function markerMesh(edgeMarkers: EdgeMarkers): Mesh<InstancedBufferGeometry> {
  const mesh = edgeMarkers.group.children[0];
  if (!(mesh instanceof Mesh) || !(mesh.geometry instanceof InstancedBufferGeometry)) {
    throw new Error("no instanced marker mesh");
  }
  return mesh;
}

function drawnBoxes(edgeMarkers: EdgeMarkers): string[] {
  const mesh = markerMesh(edgeMarkers);
  if (!mesh.visible) return [];
  const { geometry } = mesh;
  const scale = geometry.getAttribute("slotWorld0");
  const translation = geometry.getAttribute("slotWorld3");
  return Array.from(
    { length: geometry.instanceCount },
    (_, slot) => `${scale.getX(slot)} wide at x ${translation.getX(slot)}`,
  );
}

function slotBuffer(geometry: BufferGeometry): InterleavedBufferAttribute["data"] {
  const color = geometry.getAttribute("slotColor");
  if (!(color instanceof InterleavedBufferAttribute)) throw new Error("slots aren't interleaved");
  return color.data;
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
  };
}

function posedLikeBoxMeshesInAGroup(
  markers: ReadonlyArray<EdgeMarker>,
  originX: number,
  originZ: number,
) {
  const scene = new Scene();
  const group = new Group();
  group.matrixAutoUpdate = false;
  scene.add(group);
  const meshes = markers.map(({ box: at }) => {
    const mesh = new Mesh();
    mesh.matrixAutoUpdate = false;
    mesh.position.set(
      (at.minX + at.maxX) / 2 - originX,
      (at.minY + at.maxY) / 2,
      (at.minZ + at.maxZ) / 2 - originZ,
    );
    mesh.scale.set(at.maxX - at.minX, at.maxY - at.minY, at.maxZ - at.minZ);
    mesh.updateMatrix();
    group.add(mesh);
    return mesh;
  });
  group.updateMatrixWorld(true);
  return markers.map((each, index) => {
    const world = meshes[index]?.matrixWorld;
    if (!world) throw new Error("no posed mesh");
    return {
      world: [...world.elements].map(Math.fround),
      normal: [...new Matrix3().getNormalMatrix(world).elements].map(Math.fround),
      color: [...new Color(MARKER_COLORS_SRGB[each.kind]).toArray()].map(Math.fround),
    };
  });
}

function bitwiseEqual(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

it("gives every marker, in marker order and after a rebase too, the world matrix, normal matrix and colour three gives a box mesh posed at it in a group, bit for bit", () => {
  const markers = [
    marker("joined", box(0, 0, 6, 160)),
    marker("open", box(-1290, 655, -1284, 815)),
    marker("mismatch", box(9150, -12_800, 9310, -12_794, 105, 107)),
    marker("open", box(37.5, 41.25, 43.5, 201.25, 3.5, 5.5)),
    marker("joined", box(-640, -646, -480, -640)),
  ];
  const origins: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [8960, -12_800],
  ];
  const mismatches: string[] = [];
  for (const [originX, originZ] of origins) {
    const { geometry } = markerMesh(withMarkers(new EdgeMarkers(), markers, originX, originZ));
    const expected = posedLikeBoxMeshesInAGroup(markers, originX, originZ);
    expected.forEach((want, slot) => {
      const got = slotRecord(geometry, slot);
      const same =
        bitwiseEqual(got.world, want.world) &&
        bitwiseEqual(got.normal, want.normal) &&
        bitwiseEqual(got.color, want.color);
      if (!same) mismatches.push(JSON.stringify({ slot, originX, originZ, got, want }));
    });
    if (geometry.instanceCount !== markers.length)
      mismatches.push(`${geometry.instanceCount} slots`);
  }

  expect(mismatches).toEqual([]);
});

function drawOrder(scene: Scene, camera: Camera): string[] {
  const pushed: Array<RenderSortKey & { readonly name: string }> = [];
  const renderList = {
    push: (
      object: Object3D,
      _geometry: unknown,
      _material: unknown,
      groupOrder: number,
      z: number,
    ) => pushed.push({ name: object.name, groupOrder, renderOrder: object.renderOrder, z }),
  };
  const pipeline = new StandardDrawingPipeline();
  Object.assign(pipeline, { renderer: { sortObjects: true } });
  const project = pipeline.project.bind(pipeline) as unknown as (
    object: Object3D,
    camera: Camera,
    groupOrder: number,
    list: typeof renderList,
    clippingContext: null,
  ) => void;
  const begin = pipeline.begin.bind(pipeline) as unknown as (
    camera: Camera,
    renderContext: object,
  ) => void;
  begin(camera, {});
  project(scene, camera, 0, renderList, null);
  return pushed.toSorted(opaqueSort).map(({ name }) => name);
}

function named<T extends Object3D>(object: T, name: string, renderOrder?: number): T {
  object.name = name;
  if (renderOrder !== undefined) object.renderOrder = renderOrder;
  return object;
}

it("draws every marker in one item after every part, nearer or farther, before the selection outlines and the track-end arrows, and from a view that doesn't see the render origin", () => {
  const scene = new Scene();
  const parts = new Group();
  parts.add(
    named(new Mesh(new BoxGeometry(40, 40, 40), new MeshBasicNodeMaterial()), "near part"),
    named(new Mesh(new BoxGeometry(40, 40, 40), new MeshBasicNodeMaterial()), "far part"),
  );
  parts.children[0]?.position.set(0, 0, 600);
  parts.children[1]?.position.set(0, 0, -3000);
  parts.children.forEach((child) => child.updateMatrix());
  const outline = named(
    new LineSegments(new BoxGeometry(40, 40, 40)),
    "outline",
    SELECTION_RENDER_ORDER,
  );
  outline.position.set(0, 0, 600);
  const ground = named(
    new Mesh(new BoxGeometry(4000, 1, 4000), new MeshBasicNodeMaterial()),
    "ground",
    GROUND_RENDER_ORDER,
  );
  const edgeMarkers = withMarkers(new EdgeMarkers(), [
    marker("joined", box(-20, 580, 20, 586)),
    marker("open", box(-20, -100, 20, -94)),
    marker("mismatch", box(-20, -3020, 20, -3014)),
    marker("open", box(8000, 8000, 8160, 8006)),
  ]);
  markerMesh(edgeMarkers).name = "edge markers";
  const arrows = new TrackEndArrows();
  arrows.set([{ xLdu: 0, yLdu: 0, zLdu: 0, headingRadians: 0, kind: "open" }], 0, 0);
  arrows.group.children.forEach((child) => (child.name = "arrows"));
  scene.add(ground, parts, edgeMarkers.group, outline, arrows.group);
  scene.updateMatrixWorld();
  const camera = new PerspectiveCamera(40, 1.5, 20, 100_000);
  camera.position.set(0, 400, 1400);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const awayFromOrigin = new PerspectiveCamera(40, 1.5, 20, 100_000);
  awayFromOrigin.position.set(8080, 400, 8400);
  awayFromOrigin.lookAt(8080, 0, 8000);
  awayFromOrigin.updateMatrixWorld();

  expect(drawOrder(scene, camera)).toEqual([
    "ground",
    "near part",
    "far part",
    "edge markers",
    "outline",
    "arrows",
  ]);
  expect(drawOrder(scene, awayFromOrigin)).toContain("edge markers");
  expect(drawnBoxes(edgeMarkers)).toEqual([
    "40 wide at x 0",
    "40 wide at x 0",
    "40 wide at x 0",
    "160 wide at x 8080",
  ]);
});

it("writes and uploads every marker's slot when the markers change and when the render origin moves, grows past its room, and draws nothing with no markers", () => {
  const edgeMarkers = new EdgeMarkers();
  const uploads: Array<{ version: number; ranges: Array<{ start: number; count: number }> }> = [];
  const upload = (): void => {
    const slots = slotBuffer(markerMesh(edgeMarkers).geometry);
    uploads.push({
      version: slots.version,
      ranges: slots.updateRanges.map(({ start, count }) => ({ start, count })),
    });
    slots.clearUpdateRanges();
  };
  const draws: string[][] = [];

  withMarkers(edgeMarkers, [
    marker("open", box(0, 0, 6, 160)),
    marker("joined", box(160, 0, 166, 160)),
  ]);
  draws.push(drawnBoxes(edgeMarkers));
  upload();
  edgeMarkers.place(640, 0);
  draws.push(drawnBoxes(edgeMarkers));
  upload();
  withMarkers(
    edgeMarkers,
    [
      marker("open", box(0, 0, 6, 160)),
      marker("joined", box(160, 0, 166, 160)),
      marker("mismatch", box(320, 0, 480, 6)),
    ],
    640,
  );
  draws.push(drawnBoxes(edgeMarkers));
  upload();
  withMarkers(edgeMarkers, [], 640);
  draws.push(drawnBoxes(edgeMarkers));
  upload();

  expect(draws).toEqual([
    ["6 wide at x 3", "6 wide at x 163"],
    ["6 wide at x -637", "6 wide at x -477"],
    ["6 wide at x -637", "6 wide at x -477", "160 wide at x -240"],
    [],
  ]);
  expect({
    reuploadedOnRebase: (uploads[1]?.version ?? 0) > (uploads[0]?.version ?? 0),
    grownBufferUploaded: (uploads[2]?.version ?? 0) > 0,
    noneHidden: !markerMesh(edgeMarkers).visible,
    noneUploadNothing: uploads[3]?.version === uploads[2]?.version,
  }).toEqual({
    reuploadedOnRebase: true,
    grownBufferUploaded: true,
    noneHidden: true,
    noneUploadNothing: true,
  });
  expect(uploads.map(({ ranges }) => ranges)).toEqual([
    [{ start: 0, count: 2 * OVERLAY_SLOT_FLOATS }],
    [{ start: 0, count: 2 * OVERLAY_SLOT_FLOATS }],
    [{ start: 0, count: 3 * OVERLAY_SLOT_FLOATS }],
    [{ start: 0, count: 3 * OVERLAY_SLOT_FLOATS }],
  ]);
});

it("refuses markers with a hole before changing anything, and keeps placing and drawing the markers it had", () => {
  const edgeMarkers = withMarkers(new EdgeMarkers(), [marker("open", box(0, 0, 6, 160))]);
  const holed: EdgeMarker[] = [marker("joined", box(160, 0, 166, 160))];
  holed.length = 2;

  expect(() => edgeMarkers.set(holed, 0, 0)).toThrow("edge marker 1 is missing");
  edgeMarkers.place(640, 0);
  expect(drawnBoxes(edgeMarkers)).toEqual(["6 wide at x -637"]);
});
