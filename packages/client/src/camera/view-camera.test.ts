import { describe, expect, it } from "vitest";
import { FOOTPRINT_FLOATS, ViewCamera, type ViewMode } from "./view-camera.ts";

const WIDTH_PX = 1280;
const HEIGHT_PX = 720;
const SETTLED_MS = 5_000;
const LDU_TOLERANCE_DIGITS = 6;

function settledCamera(mode: ViewMode): ViewCamera {
  const camera = new ViewCamera();
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
