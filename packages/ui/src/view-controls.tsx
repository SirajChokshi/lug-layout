import type { CameraSnapshot, EditorSnapshot, IEditorCamera } from "@brr/client";
import { useSyncExternalStore } from "react";
import { shortcutText } from "./keys.tsx";

export function useCameraSnapshot(camera: IEditorCamera): CameraSnapshot {
  return useSyncExternalStore(
    (listener) => camera.subscribe(listener),
    () => camera.snapshot(),
  );
}

interface ViewControlsProps {
  readonly camera: IEditorCamera;
  readonly snapshot: EditorSnapshot;
}

export function ViewControls({ camera, snapshot }: ViewControlsProps) {
  const view = useCameraSnapshot(camera);
  const selection = snapshot.selection;
  const plan = view.mode === "plan";
  return (
    <div className="view-controls" role="toolbar" aria-label="View" data-view={view.mode}>
      <div className="view-segment" role="group" aria-label="Projection">
        <button
          type="button"
          data-action="view-orbit"
          aria-pressed={!plan}
          title={`Perspective 3D view (${shortcutText("toggle-plan-view")} toggles)`}
          onClick={() => camera.setMode("orbit")}
        >
          3D
        </button>
        <button
          type="button"
          data-action="view-plan"
          aria-pressed={plan}
          title={`Top-down 2D plan, true to scale (${shortcutText("toggle-plan-view")} toggles)`}
          onClick={() => camera.setMode("plan")}
        >
          2D plan
        </button>
      </div>
      <button
        type="button"
        data-action="fit-all"
        title={`Zoom to fit everything (${shortcutText("fit-all")})`}
        onClick={() => camera.fitAll()}
      >
        Fit all
      </button>
      <button
        type="button"
        data-action="focus-selection"
        disabled={selection === null}
        title={`Frame the selection (${shortcutText("focus")})`}
        onClick={() => {
          if (selection) camera.focus(selection.box);
        }}
      >
        Focus
      </button>
      <div className="view-segment" role="group" aria-label="Zoom">
        <button
          type="button"
          aria-label="Zoom out"
          title={`Zoom out (${shortcutText("zoom-out")})`}
          onClick={() => camera.zoomStep(-1)}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          title={`Zoom in (${shortcutText("zoom-in")})`}
          onClick={() => camera.zoomStep(1)}
        >
          +
        </button>
      </div>
      <label
        className="view-scroll"
        title="What two-finger scroll or the mouse wheel does. Pinch and Ctrl+wheel always zoom."
      >
        Scroll
        <select
          value={view.scroll}
          onChange={(event) => camera.setScroll(event.target.value === "pan" ? "pan" : "zoom")}
        >
          <option value="zoom">zooms (mouse)</option>
          <option value="pan">pans (trackpad)</option>
        </select>
      </label>
    </div>
  );
}
