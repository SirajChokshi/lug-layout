import type { EditorSnapshot, IEditor } from "@brr/client";
import { useSyncExternalStore } from "react";

export function useEditorSnapshot(editor: IEditor): EditorSnapshot {
  return useSyncExternalStore(
    (listener) => editor.subscribe(listener),
    () => editor.snapshot(),
  );
}
