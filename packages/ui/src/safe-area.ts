import { safeInsets, type IEditorCamera } from "@brr/client";
import { useEffect } from "react";

const OVERLAY_PANELS = [
  ".editor-hud",
  ".plan-panel",
  ".side-panel",
  ".minimap",
  ".view-controls",
  ".tool-hud",
  "footer",
].join(", ");

export function useSafeArea(camera: IEditorCamera, root: HTMLElement | null): void {
  useEffect(() => {
    if (!root) return;
    const measure = (): void => {
      const panels = [...root.querySelectorAll(OVERLAY_PANELS)].map((element) =>
        element.getBoundingClientRect(),
      );
      const insets = safeInsets(window.innerWidth, window.innerHeight, panels);
      camera.setSafeArea(insets.left, insets.top, insets.right, insets.bottom);
    };
    const observer = new ResizeObserver(measure);
    for (const element of root.querySelectorAll(OVERLAY_PANELS)) observer.observe(element);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [camera, root]);
}
