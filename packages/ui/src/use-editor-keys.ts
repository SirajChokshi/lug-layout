import {
  commandForKey,
  commandSpec,
  routeKey,
  runEditorAction,
  type IEditor,
  type IEditorCamera,
  type ShellCommandId,
} from "@brr/client";
import { useEffect } from "react";

const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
]);

export function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

export interface EditorKeyHandlers {
  readonly onShellCommand: (id: ShellCommandId) => void;
  readonly onPickSlot: (slot: number) => void;
  readonly overlayOpen: boolean;
  readonly closeOverlay: () => void;
}

export function useEditorKeys(
  editor: IEditor,
  camera: IEditorCamera,
  handlers: EditorKeyHandlers,
): void {
  const { onShellCommand, onPickSlot, overlayOpen, closeOverlay } = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const match = commandForKey(event, isTyping(event.target));
      if (match === null) return;
      event.preventDefault();
      if (event.repeat && commandSpec(match.id).repeats !== true) return;
      const route = routeKey(match, overlayOpen);
      switch (route.kind) {
        case "overlay":
          onShellCommand(route.id);
          return;
        case "close-overlay":
          closeOverlay();
          return;
        case "slot":
          onPickSlot(route.slot);
          return;
        case "editor":
          runEditorAction(editor, camera, route.id, event.timeStamp);
          return;
        case "blocked":
          return;
        default: {
          const unhandled: never = route;
          throw new Error(`unhandled key route ${String(unhandled)}`);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, camera, onShellCommand, onPickSlot, overlayOpen, closeOverlay]);
}
