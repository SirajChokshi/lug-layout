import type { IEditor } from "@brr/client";

const DWELL_MS = 120;

let dwell: ReturnType<typeof setTimeout> | null = null;

function cancel(): void {
  if (dwell !== null) clearTimeout(dwell);
  dwell = null;
}

export function hoverPrefetch(editor: Pick<IEditor, "prefetch">, id: string) {
  return {
    onPointerEnter: () => {
      cancel();
      dwell = setTimeout(() => {
        dwell = null;
        void editor.prefetch(id);
      }, DWELL_MS);
    },
    onPointerLeave: cancel,
    onFocus: () => void editor.prefetch(id),
  };
}
