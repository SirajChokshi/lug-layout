import type { IEditorCamera } from "../camera/editor-camera.ts";
import type { EditorMode, IEditor } from "../edit/editor.ts";
import type { ITrainPlay, PlaySnapshot } from "../play/train-play.ts";

export type ShellMode = "build" | "plan" | "play";

export const SHELL_MODES: ReadonlyArray<ShellMode> = ["build", "plan", "play"];

export function shellModeForTool(chosen: ShellMode, tool: EditorMode): ShellMode {
  if (tool === "table") return "plan";
  return chosen === "play" && tool !== "select" ? "build" : chosen;
}

export function shownShellMode(chosen: ShellMode, play: PlaySnapshot): ShellMode {
  return play.status === "loading" || play.status === "running" ? "play" : chosen;
}

export function enterShellMode(
  mode: ShellMode,
  editor: IEditor,
  camera: IEditorCamera,
  play: ITrainPlay,
): void {
  if (mode === "play") editor.chooseItem(null);
  else if (play.snapshot().status === "running") play.stop();
  if (mode === "build") editor.setTableTool(false);
  camera.setMode(mode === "plan" ? "plan" : "orbit");
}
