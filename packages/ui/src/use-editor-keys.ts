import {
  commandEnabled,
  commandForKey,
  commandSpec,
  isPlayCommand,
  isShellCommand,
  runEditorAction,
  runPlayAction,
  type IEditor,
  type IEditorCamera,
  type ITrainPlay,
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

const ACTIVATED_BY_SPACE = new Set(["checkbox", "radio", "button", "submit", "reset", "color"]);
const STEPPED_BY_ARROWS = new Set(["range", "radio"]);

export function controlTakesKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (key === " ") {
    if (target instanceof HTMLInputElement) return ACTIVATED_BY_SPACE.has(target.type);
    return (
      target instanceof HTMLButtonElement ||
      target instanceof HTMLAnchorElement ||
      target.tagName === "SUMMARY" ||
      target.getAttribute("role") === "button" ||
      target.getAttribute("role") === "checkbox"
    );
  }
  if (key.startsWith("Arrow") && target instanceof HTMLInputElement) {
    return STEPPED_BY_ARROWS.has(target.type);
  }
  return false;
}

export function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

export interface EditorKeyHandlers {
  readonly play: ITrainPlay;
  readonly onShellCommand: (id: ShellCommandId) => void;
  readonly overlayOpen: boolean;
  readonly closeOverlay: () => void;
}

export function useEditorKeys(
  editor: IEditor,
  camera: IEditorCamera,
  handlers: EditorKeyHandlers,
): void {
  const { play, onShellCommand, overlayOpen, closeOverlay } = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      if (controlTakesKey(event.target, event.key)) return;
      const id = commandForKey(event, isTyping(event.target));
      if (id === null) return;
      if (isShellCommand(id)) {
        event.preventDefault();
        onShellCommand(id);
        return;
      }
      if (overlayOpen) {
        event.preventDefault();
        if (id === "select-tool") closeOverlay();
        return;
      }
      if (!commandEnabled(id, editor.snapshot(), play.snapshot())) return;
      event.preventDefault();
      if (event.repeat && commandSpec(id).repeats !== true) return;
      if (isPlayCommand(id)) runPlayAction(editor, play, id);
      else runEditorAction(editor, camera, id, event.timeStamp);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, camera, play, onShellCommand, overlayOpen, closeOverlay]);
}
