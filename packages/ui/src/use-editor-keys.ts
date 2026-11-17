import {
  commandForKey,
  commandSpec,
  isShellCommand,
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
  readonly overlayOpen: boolean;
  readonly closeOverlay: () => void;
}

export function useEditorKeys(
  editor: IEditor,
  camera: IEditorCamera,
  handlers: EditorKeyHandlers,
): void {
  const { onShellCommand, overlayOpen, closeOverlay } = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const id = commandForKey(event, isTyping(event.target));
      if (id === null) return;
      if (event.repeat && commandSpec(id).repeats !== true) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      if (isShellCommand(id)) onShellCommand(id);
      else if (overlayOpen) {
        if (id === "select-tool") closeOverlay();
      } else runEditorAction(editor, camera, id, event.timeStamp);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, camera, onShellCommand, overlayOpen, closeOverlay]);
}
