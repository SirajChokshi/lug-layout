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
  type IHotbar,
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
const ACTIVATED_BY_ENTER = new Set(["button", "submit", "reset", "color"]);
const STEPPED_BY_ARROWS = new Set(["range", "radio"]);

function activatedByKey(target: HTMLElement): boolean {
  return (
    target instanceof HTMLButtonElement ||
    target instanceof HTMLAnchorElement ||
    target.tagName === "SUMMARY" ||
    target.getAttribute("role") === "button" ||
    target.getAttribute("role") === "checkbox"
  );
}

export function controlTakesKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (key === " ") {
    if (target instanceof HTMLInputElement) return ACTIVATED_BY_SPACE.has(target.type);
    return activatedByKey(target);
  }
  if (key === "Enter") {
    if (target instanceof HTMLInputElement) return ACTIVATED_BY_ENTER.has(target.type);
    return activatedByKey(target);
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
  readonly hotbar: IHotbar;
  readonly onShellCommand: (id: ShellCommandId) => void;
  readonly overlayOpen: boolean;
  readonly closeOverlay: () => void;
}

export function useEditorKeys(
  editor: IEditor,
  camera: IEditorCamera,
  handlers: EditorKeyHandlers,
): void {
  const { play, hotbar, onShellCommand, overlayOpen, closeOverlay } = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      if (controlTakesKey(event.target, event.key)) return;
      const match = commandForKey(event, isTyping(event.target));
      if (match === null) return;
      if (event.repeat && commandSpec(match.id).repeats !== true) {
        event.preventDefault();
        return;
      }
      if (isShellCommand(match.id)) {
        event.preventDefault();
        onShellCommand(match.id);
        return;
      }
      if (overlayOpen) {
        event.preventDefault();
        if (match.id === "select-tool") closeOverlay();
        return;
      }
      if (!commandEnabled(match.id, editor.snapshot(), play.snapshot())) return;
      event.preventDefault();
      if (match.id === "pick-slot") hotbar.pick(match.slot);
      else if (isPlayCommand(match.id)) runPlayAction(editor, play, match.id);
      else runEditorAction(editor, camera, match.id, event.timeStamp);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, camera, play, hotbar, onShellCommand, overlayOpen, closeOverlay]);
}
