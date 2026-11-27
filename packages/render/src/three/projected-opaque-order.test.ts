import {
  ArrayCamera,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Sphere,
  StandardDrawingPipeline,
  Vector3,
  WebGPUCoordinateSystem,
  type Camera,
  type Object3D,
} from "three/webgpu";
import { expect, it } from "vitest";
import { ProjectedOpaqueOrder } from "./projected-opaque-order.ts";
import { opaqueSort, type RenderSortKey } from "./tie-order.ts";

const PART_SPHERES: readonly [Sphere, ...Sphere[]] = [
  new Sphere(new Vector3(15, 44, 0), 18.4),
  new Sphere(new Vector3(0, 48, 0), 48.3),
];
const GROUP_ORDER = 3;
const RENDER_ORDER = 3;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function scatteredWorlds(random: () => number, worldCount: number): Float64Array {
  const worlds = new Float64Array(worldCount * 16);
  const matrix = new Matrix4();
  const turn = new Quaternion();
  const up = new Vector3(0, 1, 0);
  for (let w = 0; w < worldCount; w++) {
    const copyOf = w > 0 && random() < 0.3 ? Math.floor(random() * w) : -1;
    if (copyOf >= 0) {
      worlds.copyWithin(w * 16, copyOf * 16, copyOf * 16 + 16);
      continue;
    }
    turn.setFromAxisAngle(up, (random() - 0.5) * 8 * Math.PI);
    const position = new Vector3(
      (random() - 0.5) * 4000,
      Math.round(random() * 3) * 8,
      (random() - 0.5) * 4000,
    );
    matrix.compose(position, turn, new Vector3(1, 1, 1));
    worlds.set(matrix.elements, w * 16);
  }
  return worlds;
}

function threesDrawOrder(
  camera: Camera,
  worlds: Float64Array,
  partSpheres: ReadonlyArray<Sphere>,
  count: number,
): number[] {
  const scene = new Scene();
  const group = new Group();
  group.renderOrder = GROUP_ORDER;
  scene.add(group);
  const geometries = partSpheres.map((sphere) => {
    const geometry = new BufferGeometry();
    geometry.boundingSphere = sphere.clone();
    return geometry;
  });
  for (let index = 0; index < count; index++) {
    const mesh = new Mesh(geometries[index % partSpheres.length]);
    mesh.renderOrder = RENDER_ORDER;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.matrixWorld.fromArray(worlds, Math.floor(index / partSpheres.length) * 16);
    mesh.userData["index"] = index;
    group.add(mesh);
  }
  const pushed: Array<RenderSortKey & { readonly index: number }> = [];
  const renderList = {
    push: (
      object: Object3D,
      _geometry: unknown,
      _material: unknown,
      groupOrder: number,
      z: number,
    ) =>
      pushed.push({
        index: Number(object.userData["index"]),
        groupOrder,
        renderOrder: object.renderOrder,
        z,
      }),
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
  return pushed.toSorted(opaqueSort).map(({ index }) => index);
}

function perspectiveCamera(random: () => number): PerspectiveCamera {
  const camera = new PerspectiveCamera(40, 16 / 9, 20, 100_000);
  camera.position.set((random() - 0.5) * 6000, 200 + random() * 3000, (random() - 0.5) * 6000);
  camera.lookAt((random() - 0.5) * 1000, 0, (random() - 0.5) * 1000);
  camera.updateMatrixWorld();
  return camera;
}

function webGpuCamera(random: () => number): Camera {
  const camera = perspectiveCamera(random);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  return camera;
}

function cuttingCamera(random: () => number): PerspectiveCamera {
  const camera = new PerspectiveCamera(70, 16 / 9, 600 + random() * 600, 1800 + random() * 1200);
  camera.position.set((random() - 0.5) * 1500, 40 + random() * 60, (random() - 0.5) * 1500);
  camera.lookAt((random() - 0.5) * 4000, 30, (random() - 0.5) * 4000);
  camera.updateMatrixWorld();
  return camera;
}

function webGpuCuttingCamera(random: () => number): Camera {
  const camera = cuttingCamera(random);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  return camera;
}

function levelOrthographicCamera(random: () => number): Camera {
  const camera = new OrthographicCamera(-1600, 1600, 300, -300, 0, 1500);
  const x = (random() - 0.5) * 2000;
  const z = (random() - 0.5) * 2000;
  camera.position.set(x, 30, z);
  camera.lookAt(x + Math.cos(random() * 6.28), 30, z + Math.sin(random() * 6.28));
  camera.updateMatrixWorld();
  return camera;
}

function planCamera(random: () => number): Camera {
  const camera = new OrthographicCamera(-1600, 1600, 900, -900, 20, 100_000);
  const x = (random() - 0.5) * 2000;
  const z = (random() - 0.5) * 2000;
  camera.position.set(x, 5000, z + 5000 * Math.tan(1e-6));
  camera.lookAt(x, 0, z);
  camera.updateMatrixWorld();
  return camera;
}

it("culls and orders items exactly as three's drawing pipeline and the opaque sort do for one group and render order, with ties, plan views, near and far planes that cut the items, and WebGPU clip space", () => {
  const random = seeded(0x5eed);
  const order = new ProjectedOpaqueOrder();
  const mismatches: string[] = [];
  for (let count = 0; count <= 80; count++) {
    const worlds = scatteredWorlds(random, Math.ceil(count / PART_SPHERES.length));
    const cameras = [
      perspectiveCamera(random),
      planCamera(random),
      webGpuCamera(random),
      cuttingCamera(random),
      webGpuCuttingCamera(random),
      levelOrthographicCamera(random),
    ];
    for (const camera of cameras) {
      const visible = order.project(camera, worlds, PART_SPHERES, count);
      const drawn = [...order.visibleItems.subarray(0, visible)];
      const expected = threesDrawOrder(camera, worlds, PART_SPHERES, count);
      if (JSON.stringify(drawn) !== JSON.stringify(expected)) {
        mismatches.push(
          `${count} ${camera.type}: ${JSON.stringify(drawn)} vs ${JSON.stringify(expected)}`,
        );
      }
    }
  }

  expect(mismatches).toEqual([]);
});

it("refuses array cameras, whose culling it doesn't reproduce", () => {
  const order = new ProjectedOpaqueOrder();
  const worlds = new Float64Array(16);

  expect(() => order.project(new ArrayCamera(), worlds, PART_SPHERES, 2)).toThrow(
    "reversed depth and array cameras aren't reproduced",
  );
});
