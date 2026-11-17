import type { EditorOptions, IEditor } from "@brr/client";
import { useEffect, useRef } from "react";

const CLICK_SLOP_PX = 4;
const LEFT_BUTTON = 0;
const MIDDLE_BUTTON = 1;
const RIGHT_BUTTON = 2;

type DragKind = "click" | "orbit" | "pan" | "tool";

interface Drag {
  readonly kind: DragKind;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
}

function dragKind(event: PointerEvent): DragKind {
  if (event.button === RIGHT_BUTTON) return event.shiftKey ? "pan" : "orbit";
  if (event.button === MIDDLE_BUTTON || event.shiftKey) return "pan";
  return "click";
}

function ndc(canvas: HTMLCanvasElement, event: PointerEvent): readonly [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    1 - ((event.clientY - rect.top) / rect.height) * 2,
  ];
}

function historyShortcut(editor: IEditor, event: KeyboardEvent): void {
  if (event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) editor.undo(event.timeStamp);
  else if (key === "z" || key === "y") editor.redo(event.timeStamp);
  else return;
  event.preventDefault();
}

interface EditorCanvasProps {
  readonly editor: IEditor;
  readonly options: EditorOptions;
}

export function EditorCanvas({ editor, options }: EditorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || started.current) return;
    started.current = true;
    void editor.start(canvas, options);
  }, [editor, options]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let drag: Drag | null = null;
    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.button !== LEFT_BUTTON &&
        event.button !== MIDDLE_BUTTON &&
        event.button !== RIGHT_BUTTON
      )
        return;
      canvas.setPointerCapture(event.pointerId);
      const kind = dragKind(event);
      const [x, y] = ndc(canvas, event);
      drag = {
        kind: kind === "click" && editor.dragStart(x, y) ? "tool" : kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
      };
    };
    const onPointerMove = (event: PointerEvent): void => {
      const [x, y] = ndc(canvas, event);
      editor.pointerMove(x, y);
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > CLICK_SLOP_PX) {
        drag.moved = true;
      }
      if (drag.kind === "tool") editor.dragMove(x, y);
      if (drag.kind === "orbit") editor.orbit(dx, dy);
      if (drag.kind === "pan") editor.pan(dx, dy);
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const finished = drag;
      drag = null;
      canvas.releasePointerCapture(event.pointerId);
      if (finished.kind === "tool") {
        const [x, y] = ndc(canvas, event);
        editor.dragEnd(x, y, event.timeStamp);
        return;
      }
      if (finished.kind === "click" && !finished.moved) {
        const [x, y] = ndc(canvas, event);
        editor.click(x, y, event.timeStamp);
      }
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      editor.zoom(event.deltaY);
    };
    const onContextMenu = (event: Event): void => event.preventDefault();
    const onLeave = (): void => editor.pointerLeave();
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [editor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.ctrlKey || event.metaKey) {
        historyShortcut(editor, event);
        return;
      }
      switch (event.key) {
        case "r":
        case "R":
          editor.rotate(event.timeStamp);
          break;
        case "Delete":
        case "Backspace":
          editor.deleteSelection(event.timeStamp);
          break;
        case "Escape":
          editor.chooseItem(null);
          break;
        case "f":
        case "F":
          editor.focusSelection();
          break;
        case "c":
        case "C":
          editor.centreOnCursor();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor]);

  return <canvas ref={canvasRef} className="scene" />;
}
