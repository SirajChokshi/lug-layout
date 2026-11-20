import { CAMERA_FOV_DEGREES } from "@brr/render";
import { describe, expect, it } from "vitest";
import { FOOTPRINT_FLOATS, ViewCamera, type CameraTarget, type ViewMode } from "./view-camera.ts";

const WIDTH_PX = 1280;
const HEIGHT_PX = 720;
const SETTLED_MS = 5_000;
const LDU_TOLERANCE_DIGITS = 6;

function settledCamera(mode: ViewMode): ViewCamera {
  const camera = new ViewCamera(CAMERA_FOV_DEGREES);
  camera.resize(WIDTH_PX, HEIGHT_PX);
  camera.step(0);
  camera.setMode(mode);
  camera.step(1);
  camera.step(SETTLED_MS);
  return camera;
}

function ground(camera: ViewCamera, ndcX: number, ndcY: number): readonly [number, number] {
  const out = new Float64Array(6);
  camera.rayThrough(ndcX, ndcY, out);
  const [originX = 0, originY = 0, originZ = 0, dirX = 0, dirY = 0, dirZ = 0] = out;
  expect(dirY).toBeLessThan(0);
  const t = -originY / dirY;
  return [originX + dirX * t, originZ + dirZ * t];
}

function ray(camera: ViewCamera, ndcX: number, ndcY: number): ReadonlyArray<number> {
  const out = new Float64Array(6);
  camera.rayThrough(ndcX, ndcY, out);
  return [...out];
}

describe.each<ViewMode>(["orbit", "plan"])("in the %s view", (mode) => {
  it("zooming at the cursor keeps the ground point under it fixed", () => {
    const camera = settledCamera(mode);
    const cursor = [0.62, -0.35] as const;
    const before = ground(camera, ...cursor);

    camera.zoomAt(...cursor, -0.8);
    const zoomedIn = ground(camera, ...cursor);
    camera.glideZoomAt(...cursor, 1.3);
    for (let ms = SETTLED_MS; ms <= SETTLED_MS * 2; ms += 16) camera.step(ms);
    const zoomedOut = ground(camera, ...cursor);

    for (const after of [zoomedIn, zoomedOut]) {
      expect(after[0]).toBeCloseTo(before[0], LDU_TOLERANCE_DIGITS);
      expect(after[1]).toBeCloseTo(before[1], LDU_TOLERANCE_DIGITS);
    }
    expect(ground(camera, 0, 0)).not.toEqual(ground(settledCamera(mode), 0, 0));
  });

  it("dragging the ground carries the grabbed point with the cursor", () => {
    const camera = settledCamera(mode);
    const grabbed = ground(camera, -0.4, -0.2);

    camera.grabPan(-0.4, -0.2, 0.3, 0.25);

    const underCursor = ground(camera, 0.3, 0.25);
    expect(underCursor[0]).toBeCloseTo(grabbed[0], LDU_TOLERANCE_DIGITS);
    expect(underCursor[1]).toBeCloseTo(grabbed[1], LDU_TOLERANCE_DIGITS);
  });
});

it("the 2D plan looks straight down at true scale with +x to the right and +z down the screen", () => {
  const camera = settledCamera("plan");

  for (const [x, y] of [
    [0, 0],
    [-1, 1],
    [1, -1],
  ] as const) {
    const [, , , dirX, dirY, dirZ] = ray(camera, x, y);
    expect(dirX).toBeCloseTo(0, 5);
    expect(dirY).toBeCloseTo(-1, 9);
    expect(dirZ).toBeCloseTo(0, 5);
  }
  const centre = ground(camera, 0, 0);
  const right = ground(camera, 1, 0);
  const top = ground(camera, 0, 1);
  expect(right[0] - centre[0]).toBeGreaterThan(0);
  expect(right[1] - centre[1]).toBeCloseTo(0, 3);
  expect(top[1] - centre[1]).toBeLessThan(0);
  expect((right[0] - centre[0]) / (centre[1] - top[1])).toBeCloseTo(WIDTH_PX / HEIGHT_PX, 6);
});

it("gives the 2D plan one scale that maps the ground to screen pixels at every zoom, and the 3D view none", () => {
  const camera = settledCamera("plan");
  for (const logScale of [0, -1.2, 2.5]) {
    camera.zoomAt(0.3, -0.2, logScale);
    const pixelsPerLdu = camera.planPixelsPerLdu();
    const [, top] = ground(camera, 0, 1);
    const [, bottom] = ground(camera, 0, -1);
    const [left] = ground(camera, -1, 0);
    const [right] = ground(camera, 1, 0);
    expect((bottom - top) * (pixelsPerLdu ?? Number.NaN)).toBeCloseTo(HEIGHT_PX, 6);
    expect((right - left) * (pixelsPerLdu ?? Number.NaN)).toBeCloseTo(WIDTH_PX, 6);
  }
  expect(settledCamera("orbit").planPixelsPerLdu()).toBeNull();
});

it("leaving the 2D plan returns to the 3D angle it was entered from", () => {
  const camera = settledCamera("orbit");
  camera.orbit(140, -60);
  const before = ray(camera, 0, 0).slice(3);

  camera.setMode("plan");
  camera.step(SETTLED_MS + 1);
  camera.step(SETTLED_MS * 2);
  camera.setMode("orbit");
  camera.step(SETTLED_MS * 2 + 1);
  camera.step(SETTLED_MS * 3);

  const after = ray(camera, 0, 0).slice(3);
  after.forEach((component, i) => expect(component).toBeCloseTo(before[i] ?? Number.NaN, 9));
});

it("framing a layout in the 2D plan shows all of it, filling the tighter axis", () => {
  const camera = settledCamera("plan");
  const box = { minX: 1_280, minY: 0, minZ: -6_400, maxX: 9_600, maxY: 480, maxZ: -2_560 };

  camera.frame(box);
  camera.step(SETTLED_MS + 1);
  camera.step(SETTLED_MS * 2);

  const [left, top] = ground(camera, -1, 1);
  const [right, bottom] = ground(camera, 1, -1);
  expect(left).toBeLessThanOrEqual(box.minX);
  expect(right).toBeGreaterThanOrEqual(box.maxX);
  expect(top).toBeLessThanOrEqual(box.minZ);
  expect(bottom).toBeGreaterThanOrEqual(box.maxZ);
  const fill = Math.max(
    (box.maxX - box.minX) / (right - left),
    (box.maxZ - box.minZ) / (bottom - top),
  );
  expect(fill).toBeGreaterThan(0.85);
});

describe("after framing a tall model in 3D, so the orbit pivot is off the ground", () => {
  const tallBox = { minX: -320, minY: 0, minZ: -480, maxX: 640, maxY: 1_680, maxZ: 320 };

  function framedOnTallBox(): ViewCamera {
    const camera = settledCamera("orbit");
    camera.setSafeArea(420, 60, 380, 80);
    camera.frame(tallBox);
    camera.step(SETTLED_MS + 1);
    camera.step(SETTLED_MS * 2);
    return camera;
  }

  it("dragging the ground still carries the grabbed ground point with the cursor", () => {
    const camera = framedOnTallBox();
    const grabbed = ground(camera, -0.3, -0.4);

    camera.grabPan(-0.3, -0.4, 0.35, -0.1);

    const underCursor = ground(camera, 0.35, -0.1);
    expect(underCursor[0]).toBeCloseTo(grabbed[0], LDU_TOLERANCE_DIGITS);
    expect(underCursor[1]).toBeCloseTo(grabbed[1], LDU_TOLERANCE_DIGITS);
  });

  it("zooming at the cursor still keeps the ground point under it", () => {
    const camera = framedOnTallBox();
    const before = ground(camera, 0.5, -0.6);

    camera.zoomAt(0.5, -0.6, -0.7);

    const after = ground(camera, 0.5, -0.6);
    expect(after[0]).toBeCloseTo(before[0], LDU_TOLERANCE_DIGITS);
    expect(after[1]).toBeCloseTo(before[1], LDU_TOLERANCE_DIGITS);
  });

  it("centring on a ground point puts it at the centre of the uncovered area", () => {
    const camera = framedOnTallBox();
    const point = ground(camera, 0.6, -0.5);

    camera.centreOn(...point);
    camera.step(SETTLED_MS * 3);
    camera.step(SETTLED_MS * 4);

    const safeCentre = ground(camera, (420 - 380) / WIDTH_PX, (80 - 60) / HEIGHT_PX);
    expect(safeCentre[0]).toBeCloseTo(point[0], 3);
    expect(safeCentre[1]).toBeCloseTo(point[1], 3);
  });
});

it("the view footprint stays a finite quad around the target even with the horizon in view", () => {
  const camera = settledCamera("orbit");
  camera.orbit(0, -1_000);
  const footprint = new Float64Array(FOOTPRINT_FLOATS);

  camera.footprint(footprint);

  expect(footprint.every(Number.isFinite)).toBe(true);
  const targetX = footprint[FOOTPRINT_FLOATS - 2] ?? Number.NaN;
  const targetZ = footprint[FOOTPRINT_FLOATS - 1] ?? Number.NaN;
  const corners = FOOTPRINT_FLOATS / 2 - 1;
  for (let i = 0; i < corners; i++) {
    const ax = footprint[2 * i] ?? 0;
    const az = footprint[2 * i + 1] ?? 0;
    const bx = footprint[(2 * i + 2) % (2 * corners)] ?? 0;
    const bz = footprint[(2 * i + 3) % (2 * corners)] ?? 0;
    expect((bx - ax) * (targetZ - az) - (bz - az) * (targetX - ax)).toBeLessThan(0);
  }
});

it("the view footprint outlines the ground the panels leave uncovered, not the whole canvas", () => {
  const camera = settledCamera("plan");
  const [left, top, right, bottom] = [420, 60, 380, 80];
  camera.setSafeArea(left, top, right, bottom);
  const footprint = new Float64Array(FOOTPRINT_FLOATS);

  camera.footprint(footprint);

  const corners = [
    ground(camera, -1 + (2 * left) / WIDTH_PX, -1 + (2 * bottom) / HEIGHT_PX),
    ground(camera, 1 - (2 * right) / WIDTH_PX, -1 + (2 * bottom) / HEIGHT_PX),
    ground(camera, 1 - (2 * right) / WIDTH_PX, 1 - (2 * top) / HEIGHT_PX),
    ground(camera, -1 + (2 * left) / WIDTH_PX, 1 - (2 * top) / HEIGHT_PX),
  ];
  corners.forEach(([x, z], i) => {
    expect(footprint[2 * i]).toBeCloseTo(x, 6);
    expect(footprint[2 * i + 1]).toBeCloseTo(z, 6);
  });
});

function dot(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  return a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
}

function projector(
  camera: ViewCamera,
): (x: number, y: number, z: number) => readonly [number, number] {
  const [eyeX = 0, eyeY = 0, eyeZ = 0, ...forward] = ray(camera, 0, 0);
  const perUnit = (ndcX: number, ndcY: number): ReadonlyArray<number> => {
    const direction = ray(camera, ndcX, ndcY).slice(3);
    const ahead = dot(direction, forward);
    return direction.map((d, i) => d / ahead - (forward[i] ?? 0));
  };
  const across = perUnit(1, 0);
  const along = perUnit(0, 1);
  return (x, y, z) => {
    const v = [x - eyeX, y - eyeY, z - eyeZ];
    const depth = dot(v, forward);
    return [
      dot(v, across) / dot(across, across) / depth,
      dot(v, along) / dot(along, along) / depth,
    ];
  };
}

it("3D Fit all fits the box as projected, inside the uncovered area and nearly filling it", () => {
  const camera = settledCamera("orbit");
  const [left, top, right, bottom] = [420, 60, 380, 150];
  camera.setSafeArea(left, top, right, bottom);
  camera.orbit(-150, 80);
  const box = { minX: -2_400, minY: 0, minZ: -640, maxX: 1_280, maxY: 960, maxZ: 1_920 };

  camera.frame(box);
  camera.step(SETTLED_MS + 1);
  camera.step(SETTLED_MS * 2);

  const project = projector(camera);
  const safe = {
    left: -1 + (2 * left) / WIDTH_PX,
    right: 1 - (2 * right) / WIDTH_PX,
    bottom: -1 + (2 * bottom) / HEIGHT_PX,
    top: 1 - (2 * top) / HEIGHT_PX,
  };
  let fill = 0;
  for (const x of [box.minX, box.maxX]) {
    for (const y of [box.minY, box.maxY]) {
      for (const z of [box.minZ, box.maxZ]) {
        const [ndcX, ndcY] = project(x, y, z);
        expect(ndcX).toBeGreaterThanOrEqual(safe.left);
        expect(ndcX).toBeLessThanOrEqual(safe.right);
        expect(ndcY).toBeGreaterThanOrEqual(safe.bottom);
        expect(ndcY).toBeLessThanOrEqual(safe.top);
        fill = Math.max(
          fill,
          (ndcX - (safe.left + safe.right) / 2) / ((safe.right - safe.left) / 2),
          (ndcY - (safe.bottom + safe.top) / 2) / ((safe.top - safe.bottom) / 2),
        );
      }
    }
  }
  expect(fill).toBeGreaterThan(0.8);
});

it("starts north up in 3D: up the screen is -z on the ground, right is +x", () => {
  const camera = settledCamera("orbit");

  const centre = ground(camera, 0, 0);
  const up = ground(camera, 0, 0.5);
  const right = ground(camera, 0.5, 0);

  expect(up[0]).toBeCloseTo(centre[0], 6);
  expect(up[1]).toBeLessThan(centre[1]);
  expect(right[0]).toBeGreaterThan(centre[0]);
  expect(right[1]).toBeCloseTo(centre[1], 6);
});

it("recomputes the view footprint only when the view has changed", () => {
  const camera = settledCamera("orbit");
  const first = new Float64Array(FOOTPRINT_FLOATS);
  const again = new Float64Array(FOOTPRINT_FLOATS);

  expect(camera.footprint(first)).toBe(true);
  expect(camera.footprint(again)).toBe(false);
  expect([...again]).toEqual([...first]);

  camera.orbit(30, 0);
  expect(camera.footprint(again)).toBe(true);
  expect([...again]).not.toEqual([...first]);
  camera.setSafeArea(200, 0, 0, 0);
  expect(camera.footprint(again)).toBe(true);
  expect(camera.footprint(again)).toBe(false);
});

describe.each([
  [900, 0, 0, 0],
  [0, 0, 900, 0],
  [0, 330, 0, 0],
  [800, 0, 100, 360],
])(
  "3D Fit all with panels on one side (left %i, top %i, right %i, bottom %i)",
  (left, top, right, bottom) => {
    it("keeps every corner of varied boxes inside the uncovered area from varied angles", () => {
      let seed = left * 7 + top * 13 + right * 17 + bottom * 19 + 1;
      const random = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
      const safe = {
        left: -1 + (2 * left) / WIDTH_PX,
        right: 1 - (2 * right) / WIDTH_PX,
        bottom: -1 + (2 * bottom) / HEIGHT_PX,
        top: 1 - (2 * top) / HEIGHT_PX,
      };
      for (let fit = 0; fit < 40; fit++) {
        const camera = settledCamera("orbit");
        camera.setSafeArea(left, top, right, bottom);
        camera.orbit((random() - 0.5) * 1_200, (random() - 0.5) * 400);
        const [sizeX, sizeY, sizeZ] = [
          50 + random() * 5_000,
          8 + random() * 3_000,
          50 + random() * 5_000,
        ];
        const [centreX, centreZ] = [(random() - 0.5) * 20_000, (random() - 0.5) * 20_000];
        const box = {
          minX: centreX - sizeX / 2,
          minY: 0,
          minZ: centreZ - sizeZ / 2,
          maxX: centreX + sizeX / 2,
          maxY: sizeY,
          maxZ: centreZ + sizeZ / 2,
        };

        camera.frame(box);
        camera.step(SETTLED_MS + 1);
        camera.step(SETTLED_MS * 2);

        const project = projector(camera);
        let fill = 0;
        for (const x of [box.minX, box.maxX]) {
          for (const y of [box.minY, box.maxY]) {
            for (const z of [box.minZ, box.maxZ]) {
              const [ndcX, ndcY] = project(x, y, z);
              fill = Math.max(
                fill,
                Math.abs(ndcX - (safe.left + safe.right) / 2) / ((safe.right - safe.left) / 2),
                Math.abs(ndcY - (safe.bottom + safe.top) / 2) / ((safe.top - safe.bottom) / 2),
              );
            }
          }
        }
        expect(fill).toBeLessThanOrEqual(1);
        expect(fill).toBeGreaterThan(0.85);
      }
    });
  },
);

it("sends the view to its target only when the eye, target or projection changes", () => {
  const sent: Array<ReadonlyArray<number | undefined>> = [];
  const target: CameraTarget = {
    setView: (...view) => {
      sent.push(view);
    },
  };
  const camera = settledCamera("orbit");
  const sends: number[] = [];
  const applyAndCount = (): void => {
    camera.apply(target);
    sends.push(sent.length);
  };

  applyAndCount();
  applyAndCount();
  camera.orbit(20, 0);
  applyAndCount();
  camera.setMode("plan");
  camera.step(SETTLED_MS + 1);
  camera.step(SETTLED_MS * 2);
  applyAndCount();
  applyAndCount();
  camera.zoomAtSafeCentre(-0.5);
  applyAndCount();

  const beforeZoom = sent.at(-2) ?? [];
  const afterZoom = sent.at(-1) ?? [];
  expect({
    sends,
    zoomKeepsEyeAndTarget: beforeZoom.slice(0, 6).join() === afterZoom.slice(0, 6).join(),
    zoomChangesHalfHeight: beforeZoom[6] !== afterZoom[6],
  }).toEqual({
    sends: [1, 1, 2, 3, 3, 4],
    zoomKeepsEyeAndTarget: true,
    zoomChangesHalfHeight: true,
  });
});
