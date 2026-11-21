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
      const match = commandForKey(event, isTyping(event.target), (candidate) =>
        commandEnabled(candidate, editor.snapshot(), play.snapshot()),
      );
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
        if (match.id === "select-tool" || match.id === "cancel") closeOverlay();
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
  useAltHold(editor, play);
}

const ALT = "Alt";
const ALT_GRAPH = "AltGraph";

function useAltHold(editor: IEditor, play: ITrainPlay): void {
  useEffect(() => {
    let altDown = false;
    const toggles = (): boolean => play.snapshot().status !== "running";
    const hold = (held: boolean): void => holdPlacementModeOverride(editor, held && toggles());
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
      altDown = event.altKey && !event.ctrlKey && !isTyping(document.activeElement);
      hold(altDown);
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
      release();
    };
  }, [editor, play]);
}
