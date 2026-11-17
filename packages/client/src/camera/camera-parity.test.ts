import { RAY_FLOATS, SCENE_BACKEND } from "@brr/render";
import { Container } from "inversify";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { ViewCamera, type ViewMode } from "./view-camera.ts";

const WIDTH_PX = 1280;
const HEIGHT_PX = 720;
const SETTLED_MS = 5_000;
const CURSORS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-1, 1],
  [0.7, -0.4],
  [1, -1],
];

it.each<ViewMode>(["orbit", "plan"])(
  "the camera's own rays match the renderer's in the %s view, so anchors land where the editor picks",
  (mode) => {
    const container = new Container();
    container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
    const backend = container.get(SCENE_BACKEND);
    backend.resize(WIDTH_PX, HEIGHT_PX);
    const camera = new ViewCamera();
    camera.resize(WIDTH_PX, HEIGHT_PX);
    camera.step(0);
    camera.setMode(mode);
    camera.step(1);
    camera.step(SETTLED_MS);
    camera.orbit(90, -40);
    camera.grabPan(0, 0, 0.3, 0.2);
    camera.zoomAt(0.2, -0.3, -0.5);
    camera.apply(backend);

    const ours = new Float64Array(RAY_FLOATS);
    const renderer = new Float64Array(RAY_FLOATS);
    for (const [x, y] of CURSORS) {
      camera.rayThrough(x, y, ours);
      backend.rayThrough(x, y, renderer);
      const groundOurs = [
        (ours[0] ?? 0) - ((ours[1] ?? 0) / (ours[4] ?? 1)) * (ours[3] ?? 0),
        (ours[2] ?? 0) - ((ours[1] ?? 0) / (ours[4] ?? 1)) * (ours[5] ?? 0),
      ];
      const groundRenderer = [
        (renderer[0] ?? 0) - ((renderer[1] ?? 0) / (renderer[4] ?? 1)) * (renderer[3] ?? 0),
        (renderer[2] ?? 0) - ((renderer[1] ?? 0) / (renderer[4] ?? 1)) * (renderer[5] ?? 0),
      ];
      expect(groundRenderer[0]).toBeCloseTo(groundOurs[0] ?? Number.NaN, 2);
      expect(groundRenderer[1]).toBeCloseTo(groundOurs[1] ?? Number.NaN, 2);
    }
  },
);
