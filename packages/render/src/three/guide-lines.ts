import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicNodeMaterial,
  LineSegments,
} from "three/webgpu";
import type { GuideKind, GuideSegment } from "../scene-backend.ts";

const GUIDE_KINDS: ReadonlyArray<GuideKind> = ["ruler", "axis", "draft"];
const GUIDE_COLORS: Readonly<Record<GuideKind, number>> = {
  ruler: 0x1f62d1,
  axis: 0x16222c,
  draft: 0x2f74e8,
};
const GUIDE_RENDER_ORDER = 3;
const FLOATS_PER_VERTEX = 3;
const VERTICES_PER_SEGMENT = 2;
const FLOATS_PER_SEGMENT = FLOATS_PER_VERTEX * VERTICES_PER_SEGMENT;
const INITIAL_SEGMENTS = 16;
const UNSET_KIND = -1;

export class GuideLines {
  readonly lines: LineSegments;
  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private kinds = new Int8Array(0);
  private readonly kindColors = GUIDE_KINDS.map((kind) => new Color(GUIDE_COLORS[kind]));
  private anchorX = 0;
  private anchorZ = 0;

  constructor() {
    this.lines = new LineSegments(
      new BufferGeometry(),
      new LineBasicNodeMaterial({ vertexColors: true, depthTest: false }),
    );
    this.lines.matrixAutoUpdate = false;
    this.lines.frustumCulled = false;
    this.lines.renderOrder = GUIDE_RENDER_ORDER;
    this.lines.visible = false;
    this.reserve(INITIAL_SEGMENTS);
  }

  set(segments: ReadonlyArray<GuideSegment>): void {
    if (segments.length > this.kinds.length) this.reserve(segments.length * 2);
    const first = segments[0];
    this.anchorX = first?.ax ?? 0;
    this.anchorZ = first?.az ?? 0;
    let recoloured = false;
    for (let s = 0; s < segments.length; s++) {
      const segment = segments[s];
      if (!segment) continue;
      const o = s * FLOATS_PER_SEGMENT;
      this.positions[o] = segment.ax - this.anchorX;
      this.positions[o + 1] = segment.ay;
      this.positions[o + 2] = segment.az - this.anchorZ;
      this.positions[o + 3] = segment.bx - this.anchorX;
      this.positions[o + 4] = segment.by;
      this.positions[o + 5] = segment.bz - this.anchorZ;
      const kind = GUIDE_KINDS.indexOf(segment.kind);
      if (this.kinds[s] === kind) continue;
      this.kinds[s] = kind;
      this.paint(o, kind);
      recoloured = true;
    }
    const geometry = this.lines.geometry;
    const position = geometry.getAttribute("position");
    if (position instanceof BufferAttribute) position.needsUpdate = true;
    const color = geometry.getAttribute("color");
    if (recoloured && color instanceof BufferAttribute) color.needsUpdate = true;
    geometry.setDrawRange(0, segments.length * VERTICES_PER_SEGMENT);
    this.lines.visible = segments.length > 0;
  }

  place(renderOriginX: number, renderOriginZ: number): void {
    this.lines.position.set(this.anchorX - renderOriginX, 0, this.anchorZ - renderOriginZ);
    this.lines.updateMatrix();
    this.lines.updateMatrixWorld(true);
  }

  private paint(offset: number, kind: number): void {
    const color = this.kindColors[kind];
    if (!color) throw new Error(`no colour for guide kind ${kind}`);
    for (let v = 0; v < VERTICES_PER_SEGMENT; v++) {
      const c = offset + v * FLOATS_PER_VERTEX;
      this.colors[c] = color.r;
      this.colors[c + 1] = color.g;
      this.colors[c + 2] = color.b;
    }
  }

  private reserve(segments: number): void {
    this.positions = new Float32Array(segments * FLOATS_PER_SEGMENT);
    this.colors = new Float32Array(segments * FLOATS_PER_SEGMENT);
    this.kinds = new Int8Array(segments).fill(UNSET_KIND);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(this.positions, FLOATS_PER_VERTEX));
    geometry.setAttribute("color", new BufferAttribute(this.colors, FLOATS_PER_VERTEX));
    this.lines.geometry.dispose();
    this.lines.geometry = geometry;
  }
}
