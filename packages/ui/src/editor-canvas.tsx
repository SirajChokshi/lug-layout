import type { EditorOptions, IEditor, IEditorCamera, ITrainPlay } from "@brr/client";
import { useEffect, useRef } from "react";
import { controlTakesKey, isTyping } from "./use-editor-keys.ts";

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
  lastNdcX: number;
  lastNdcY: number;
  moved: boolean;
}

interface Pointer {
  ndcX: number;
  ndcY: number;
  spaceHeld: boolean;
}

function dragKind(event: PointerEvent, camera: IEditorCamera, spaceHeld: boolean): DragKind {
  const plan = camera.snapshot().mode === "plan";
  if (event.button === RIGHT_BUTTON) return event.shiftKey || plan ? "pan" : "orbit";
  if (event.button === MIDDLE_BUTTON || event.shiftKey || spaceHeld) return "pan";
  return "click";
}

function ndc(canvas: HTMLCanvasElement, event: MouseEvent): readonly [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    1 - ((event.clientY - rect.top) / rect.height) * 2,
  ];
}

function gestureScale(event: Event): number | null {
  return "scale" in event && typeof event.scale === "number" ? event.scale : null;
}

interface EditorCanvasProps {
  readonly editor: IEditor;
  readonly camera: IEditorCamera;
  readonly play: ITrainPlay;
  readonly options: EditorOptions;
}

export function EditorCanvas({ editor, camera, play, options }: EditorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const started = useRef(false);
  const pointer = useRef<Pointer>({ ndcX: 0, ndcY: 0, spaceHeld: false });

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
    let gestureLastScale = 1;
    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.button !== LEFT_BUTTON &&
        event.button !== MIDDLE_BUTTON &&
        event.button !== RIGHT_BUTTON
      )
        return;
      canvas.setPointerCapture(event.pointerId);
      const kind = dragKind(event, camera, pointer.current.spaceHeld);
      const [x, y] = ndc(canvas, event);
      const playing = play.snapshot().status === "running";
      drag = {
        kind: kind === "click" && !playing && editor.dragStart(x, y) ? "tool" : kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        lastNdcX: x,
        lastNdcY: y,
        moved: false,
      };
      canvas.dataset["drag"] = drag.kind;
    };
    const onPointerMove = (event: PointerEvent): void => {
      const [x, y] = ndc(canvas, event);
      pointer.current.ndcX = x;
      pointer.current.ndcY = y;
      const active = drag && drag.pointerId === event.pointerId ? drag : null;
      if (active) {
        if (active.kind === "orbit")
          camera.orbit(event.clientX - active.lastX, event.clientY - active.lastY);
        if (active.kind === "pan") camera.pan(active.lastNdcX, active.lastNdcY, x, y);
        active.lastX = event.clientX;
        active.lastY = event.clientY;
        active.lastNdcX = x;
        active.lastNdcY = y;
        if (
          Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > CLICK_SLOP_PX
        ) {
          active.moved = true;
        }
      }
      editor.pointerMove(x, y);
      if (active?.kind === "tool") editor.dragMove(x, y);
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const finished = drag;
      drag = null;
      delete canvas.dataset["drag"];
      canvas.releasePointerCapture(event.pointerId);
      if (finished.kind === "tool") {
        const [x, y] = ndc(canvas, event);
        editor.dragEnd(x, y, event.timeStamp);
        return;
      }
      if (finished.kind === "click" && !finished.moved) {
        const [x, y] = ndc(canvas, event);
        if (play.snapshot().status === "running") {
          play.click(x, y);
          return;
        }
        editor.click(x, y, event.timeStamp);
      }
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const [x, y] = ndc(canvas, event);
      camera.wheel({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        ndcX: x,
        ndcY: y,
      });
      editor.pointerMove(x, y);
    };
    const onGestureStart = (event: Event): void => {
      event.preventDefault();
      gestureLastScale = gestureScale(event) ?? 1;
    };
    const onGestureChange = (event: Event): void => {
      event.preventDefault();
      const scale = gestureScale(event);
      if (scale === null) return;
      camera.pinch(scale / gestureLastScale, pointer.current.ndcX, pointer.current.ndcY);
      gestureLastScale = scale;
      editor.pointerMove(pointer.current.ndcX, pointer.current.ndcY);
    };
    const onDoubleClick = (): void => {
      const box = editor.snapshot().selection?.box;
      if (box) camera.focus(box);
    };
    const onContextMenu = (event: Event): void => event.preventDefault();
    const onLeave = (): void => editor.pointerLeave();
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", onGestureStart);
    canvas.addEventListener("gesturechange", onGestureChange);
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("dblclick", onDoubleClick);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("dblclick", onDoubleClick);
    };
  }, [editor, camera, play]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const isSpace = (event: KeyboardEvent): boolean =>
      event.key === " " && !isTyping(event.target) && !controlTakesKey(event.target, " ");
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSpace(event)) return;
      pointer.current.spaceHeld = true;
      if (canvas) canvas.dataset["space"] = "";
    };
    const release = (): void => {
      pointer.current.spaceHeld = false;
      if (canvas) delete canvas.dataset["space"];
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === " ") release();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
    };
  }, []);

  return <canvas ref={canvasRef} className="scene" />;
}
