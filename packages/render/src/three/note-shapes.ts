import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  LineBasicNodeMaterial,
  LineSegments,
  Mesh,
  MeshBasicNodeMaterial,
  ShapeUtils,
  Vector2,
} from "three/webgpu";
import type { NoteArea, NotePath, NoteShapes } from "../scene-backend.ts";

const FILL_OPACITY = 0.3;
const FILL_RENDER_ORDER = 2;
const LINE_RENDER_ORDER = 3;
const FLOATS_PER_VERTEX = 3;
const FLOATS_PER_POINT = 2;
const VERTICES_PER_SEGMENT = 2;

function pointCount(points: Float64Array): number {
  return Math.floor(points.length / FLOATS_PER_POINT);
}

function segmentCount(path: NotePath): number {
  const points = pointCount(path.points);
  if (points < 2) return 0;
  return path.closed ? points : points - 1;
}

function firstPoint(shapes: NoteShapes): readonly [number, number] {
  const points = shapes.areas[0]?.outline ?? shapes.paths[0]?.points;
  return [points?.[0] ?? 0, points?.[1] ?? 0];
}

function contourOf(outline: Float64Array, anchorX: number, anchorZ: number): Vector2[] {
  const contour: Vector2[] = [];
  for (let p = 0; p < pointCount(outline); p++) {
    const o = p * FLOATS_PER_POINT;
    contour.push(new Vector2((outline[o] ?? 0) - anchorX, (outline[o + 1] ?? 0) - anchorZ));
  }
  return contour;
}

export class NoteShapeLayer {
  readonly fills: Mesh;
  readonly lines: LineSegments;
  private readonly color = new Color();
  private anchorX = 0;
  private anchorZ = 0;
  private hasFills = false;

  constructor() {
    this.fills = new Mesh(
      new BufferGeometry(),
      new MeshBasicNodeMaterial({
        vertexColors: true,
        transparent: true,
        opacity: FILL_OPACITY,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    this.lines = new LineSegments(
      new BufferGeometry(),
      new LineBasicNodeMaterial({ vertexColors: true, depthTest: false }),
    );
    for (const object of [this.fills, this.lines]) {
      object.matrixAutoUpdate = false;
      object.frustumCulled = false;
      object.visible = false;
    }
    this.fills.renderOrder = FILL_RENDER_ORDER;
    this.lines.renderOrder = LINE_RENDER_ORDER;
  }

  set(shapes: NoteShapes): void {
    [this.anchorX, this.anchorZ] = firstPoint(shapes);
    this.setFills(shapes.areas, shapes.y);
    this.setLines(shapes.paths, shapes.y);
  }

  showFills(shown: boolean): void {
    this.fills.visible = shown && this.hasFills;
  }

  place(renderOriginX: number, renderOriginZ: number): void {
    for (const object of [this.fills, this.lines]) {
      object.position.set(this.anchorX - renderOriginX, 0, this.anchorZ - renderOriginZ);
      object.updateMatrix();
      object.updateMatrixWorld(true);
    }
  }

  private setFills(areas: ReadonlyArray<NoteArea>, y: number): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (const area of areas) {
      const contour = contourOf(area.outline, this.anchorX, this.anchorZ);
      const base = positions.length / FLOATS_PER_VERTEX;
      this.color.setHex(area.rgb);
      for (const corner of contour) {
        positions.push(corner.x, y, corner.y);
        colors.push(this.color.r, this.color.g, this.color.b);
      }
      for (const triangle of ShapeUtils.triangulateShape(contour, [])) {
        for (const corner of triangle) indices.push(base + corner);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(Float32Array.from(positions), FLOATS_PER_VERTEX),
    );
    geometry.setAttribute(
      "color",
      new BufferAttribute(Float32Array.from(colors), FLOATS_PER_VERTEX),
    );
    geometry.setIndex(indices);
    this.fills.geometry.dispose();
    this.fills.geometry = geometry;
    this.hasFills = indices.length > 0;
  }

  private setLines(paths: ReadonlyArray<NotePath>, y: number): void {
    let segments = 0;
    for (const path of paths) segments += segmentCount(path);
    const positions = new Float32Array(segments * VERTICES_PER_SEGMENT * FLOATS_PER_VERTEX);
    const colors = new Float32Array(positions.length);
    let o = 0;
    for (const path of paths) {
      const { points } = path;
      const count = pointCount(points);
      this.color.setHex(path.rgb);
      for (let s = 0; s < segmentCount(path); s++) {
        for (const p of [s, (s + 1) % count]) {
          positions[o] = (points[p * FLOATS_PER_POINT] ?? 0) - this.anchorX;
          positions[o + 1] = y;
          positions[o + 2] = (points[p * FLOATS_PER_POINT + 1] ?? 0) - this.anchorZ;
          colors[o] = this.color.r;
          colors[o + 1] = this.color.g;
          colors[o + 2] = this.color.b;
          o += FLOATS_PER_VERTEX;
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, FLOATS_PER_VERTEX));
    geometry.setAttribute("color", new BufferAttribute(colors, FLOATS_PER_VERTEX));
    this.lines.geometry.dispose();
    this.lines.geometry = geometry;
    this.lines.visible = segments > 0;
  }
}
