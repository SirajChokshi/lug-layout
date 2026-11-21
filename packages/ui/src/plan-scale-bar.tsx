import type { IScaleBar, ScaleBarView } from "@brr/client";
import { useSyncExternalStore } from "react";

function useScaleBarView(scaleBar: IScaleBar): ScaleBarView | null {
  return useSyncExternalStore(
    (listener) => scaleBar.subscribe(listener),
    () => scaleBar.view(),
  );
}

export function PlanScaleBar({ scaleBar }: { readonly scaleBar: IScaleBar }) {
  const view = useScaleBarView(scaleBar);
  if (!view) return null;
  return (
    <div
      className="scale-bar"
      role="img"
      aria-label={`Scale: ${view.label}`}
      data-studs={view.studs}
      data-width-px={view.widthPx}
    >
      <span className="scale-bar-label">{view.label}</span>
      <div className="scale-bar-rule" style={{ width: `${view.widthPx}px` }} />
    </div>
  );
}
