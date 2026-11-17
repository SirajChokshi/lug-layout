import type { IEditorCamera } from "@brr/client";
import { useEffect } from "react";

const LEFT_PANELS = [".editor-hud", ".plan-panel"];
const RIGHT_PANELS = [".side-panel"];
const TOP_PANELS = [".view-controls"];
const BOTTOM_PANELS = ["footer"];
const GAP_PX = 8;

function rects(root: HTMLElement, selectors: ReadonlyArray<string>): DOMRect[] {
  return selectors.flatMap((selector) =>
    [...root.querySelectorAll(selector)].map((element) => element.getBoundingClientRect()),
  );
}

function inset(values: ReadonlyArray<number>): number {
  return values.length === 0 ? 0 : Math.max(0, ...values) + GAP_PX;
}

export function useSafeArea(camera: IEditorCamera, root: HTMLElement | null): void {
  useEffect(() => {
    if (!root) return;
    const measure = (): void => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      camera.setSafeArea(
        inset(rects(root, LEFT_PANELS).map((rect) => rect.right)),
        inset(rects(root, TOP_PANELS).map((rect) => rect.bottom)),
        inset(rects(root, RIGHT_PANELS).map((rect) => width - rect.left)),
        inset(rects(root, BOTTOM_PANELS).map((rect) => height - rect.top)),
      );
    };
    const observer = new ResizeObserver(measure);
    for (const selector of [...LEFT_PANELS, ...RIGHT_PANELS, ...TOP_PANELS, ...BOTTOM_PANELS]) {
      for (const element of root.querySelectorAll(selector)) observer.observe(element);
    }
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [camera, root]);
}
