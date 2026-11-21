import type { EditorOptions, IEditor, IEditorCamera, IPaletteDrag, ITrainPlay } from "@brr/client";
import { useEffect, useRef } from "react";
import { controlTakesKey, isTyping } from "./use-editor-keys.ts";
import { carriesPaletteItem } from "./palette-drag.ts";
import { carriesFiles, importModelFiles } from "./model-files.ts";

const CLICK_SLOP_PX = 4;
const LEFT_BUTTON = 0;
const MIDDLE_BUTTON = 1;
const RIGHT_BUTTON = 2;

type DragKind = "click" | "extend" | "orbit" | "pan" | "tool" | "box" | "move";

interface Drag {
  kind: DragKind;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startNdcX: number;
  readonly startNdcY: number;
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
  if (event.button === MIDDLE_BUTTON || spaceHeld) return "pan";
  if (event.shiftKey) return "extend";
  return "click";
}

function showMarquee(marquee: HTMLDivElement | null, drag: Drag, event: PointerEvent): void {
  if (!marquee) return;
  marquee.hidden = false;
  marquee.style.left = `${Math.min(drag.startX, event.clientX)}px`;
  marquee.style.top = `${Math.min(drag.startY, event.clientY)}px`;
  marquee.style.width = `${Math.abs(event.clientX - drag.startX)}px`;
  marquee.style.height = `${Math.abs(event.clientY - drag.startY)}px`;
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
  readonly paletteDrag: IPaletteDrag;
  readonly options: EditorOptions;
}

export function EditorCanvas({ editor, camera, play, paletteDrag, options }: EditorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);
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
    const hideMarquee = (): void => {
      if (marqueeRef.current) marqueeRef.current.hidden = true;
    };
    const setKind = (active: Drag, kind: DragKind): void => {
      active.kind = kind;
      canvas.dataset["drag"] = kind;
    };
    const startDragging = (active: Drag, event: PointerEvent, x: number, y: number): void => {
      if (active.kind === "extend") {
        setKind(active, "pan");
        camera.pan(active.startNdcX, active.startNdcY, x, y);
        return;
      }
      if (play.snapshot().status === "running") return;
      const selectDrag = editor.selectDragStart(
        active.startNdcX,
        active.startNdcY,
        event.ctrlKey || event.metaKey,
      );
      if (selectDrag) setKind(active, selectDrag);
    };
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
        startNdcX: x,
        startNdcY: y,
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
        const crossing =
          !active.moved &&
          Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > CLICK_SLOP_PX;
        if (crossing) active.moved = true;
        if (crossing && (active.kind === "click" || active.kind === "extend")) {
          startDragging(active, event, x, y);
        } else if (active.kind === "orbit") {
          camera.orbit(event.clientX - active.lastX, event.clientY - active.lastY);
        } else if (active.kind === "pan") {
          camera.pan(active.lastNdcX, active.lastNdcY, x, y);
        }
        active.lastX = event.clientX;
        active.lastY = event.clientY;
        active.lastNdcX = x;
        active.lastNdcY = y;
      }
      editor.pointerMove(x, y);
      if (active?.kind === "tool") editor.dragMove(x, y);
      if (active?.kind === "box" || active?.kind === "move") editor.selectDragMove(x, y);
      if (active?.kind === "box") showMarquee(marqueeRef.current, active, event);
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const finished = drag;
      drag = null;
      delete canvas.dataset["drag"];
      canvas.releasePointerCapture(event.pointerId);
      hideMarquee();
      const [x, y] = ndc(canvas, event);
      if (finished.kind === "tool") {
        editor.dragEnd(x, y, event.timeStamp);
        return;
      }
      if (finished.kind === "box" || finished.kind === "move") {
        if (event.type === "pointercancel") editor.cancelGesture();
        else editor.selectDragEnd(x, y, event.timeStamp);
        return;
      }
      if ((finished.kind === "click" || finished.kind === "extend") && !finished.moved) {
        if (play.snapshot().status === "running") {
          play.click(x, y);
          return;
        }
        if (finished.kind === "extend") editor.toggleSelected(x, y);
        else editor.click(x, y, event.timeStamp);
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
    const onDragOver = (event: DragEvent): void => {
      if (carriesFiles(event)) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        return;
      }
      if (!carriesPaletteItem(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      const [x, y] = ndc(canvas, event);
      pointer.current.ndcX = x;
      pointer.current.ndcY = y;
      editor.pointerMove(x, y);
    };
    const onDrop = (event: DragEvent): void => {
      if (carriesFiles(event)) {
        event.preventDefault();
        const [x, y] = ndc(canvas, event);
        void importModelFiles(editor, event.dataTransfer?.files ?? []).then((imported) => {
          if (!imported) return;
          editor.pointerMove(x, y);
          editor.click(x, y, performance.now());
        });
        return;
      }
      if (!carriesPaletteItem(event)) return;
      event.preventDefault();
      const [x, y] = ndc(canvas, event);
      paletteDrag.drop(x, y, event.timeStamp);
    };
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
    canvas.addEventListener("dragover", onDragOver);
    canvas.addEventListener("dragleave", onLeave);
    canvas.addEventListener("drop", onDrop);
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
      canvas.removeEventListener("dragover", onDragOver);
      canvas.removeEventListener("dragleave", onLeave);
      canvas.removeEventListener("drop", onDrop);
    };
  }, [editor, camera, play, paletteDrag]);

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

  return (
    <>
      <canvas ref={canvasRef} className="scene" />
      <div ref={marqueeRef} className="marquee" hidden />
    </>
  );
}
