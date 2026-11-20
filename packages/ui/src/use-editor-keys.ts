import {
  commandEnabled,
  commandForKey,
  commandSpec,
  holdPlacementModeOverride,
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
      if (event.repeat && commandSpec(id).repeats !== true) {
        event.preventDefault();
        return;
      }
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
      if (isPlayCommand(id)) runPlayAction(editor, play, id);
      else runEditorAction(editor, camera, id, event.timeStamp);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, camera, play, onShellCommand, overlayOpen, closeOverlay]);
  useAltHold(editor);
}

const ALT = "Alt";
const ALT_GRAPH = "AltGraph";

function useAltHold(editor: IEditor): void {
  useEffect(() => {
    let altDown = false;
    const hold = (held: boolean): void => holdPlacementModeOverride(editor, held);
    const placing = (): boolean => editor.snapshot().mode === "place";
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== ALT || event.ctrlKey || isTyping(event.target)) return;
      if (placing()) event.preventDefault();
      altDown = true;
      hold(true);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== ALT && event.key !== ALT_GRAPH) return;
      if (altDown && placing()) event.preventDefault();
      altDown = false;
      hold(false);
    };
    const onPointer = (event: PointerEvent): void => {
      if (event.altKey && !event.ctrlKey && !isTyping(document.activeElement)) {
        altDown = true;
        hold(true);
      } else if (!altDown) {
        hold(false);
      }
    };
    const release = (): void => {
      altDown = false;
      hold(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("blur", release);
    };
  }, [editor]);
}
