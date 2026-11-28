import type { StudPrimitiveAsset } from "@brr/catalog";
import { CHUNK_LDU, chunkKey } from "@brr/math";
import {
  BufferAttribute,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  BufferGeometry as LineGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineBasicNodeMaterial,
  LineSegments,
  Mesh,
  MeshBasicNodeMaterial,
} from "three/webgpu";
import {
  attribute,
  cos,
  float,
  fwidth,
  length,
  max,
  mix,
  positionGeometry,
  round,
  sin,
  smoothstep,
  texture,
  varying,
  vec3,
} from "three/tsl";
import {
  PLAN_POSE_FLOATS,
  PLAN_POSE_ROT,
  PLAN_POSE_X,
  PLAN_POSE_Y,
  PLAN_POSE_Z,
  type IPlanSceneBackend,
  type PlanInstances,
  type PlanPartLines,
  type PlanSprite,
} from "../plan-scene.ts";
import { COLOR_CHANNELS } from "../scene-backend.ts";
import { type AtlasPage, type AtlasSlot, GlyphAtlas, type LdrawColorOf } from "./glyph-atlas.ts";
import {
  MATRIX4_FLOATS,
  STUD_COLOR_INDEX_SHIFT,
  TRANSLATION_FLOATS,
  studBasisIndexOf,
  type InstancePage,
} from "./instance-page.ts";
import { STUD_BASIS_FLOATS, type StudBasisTable } from "./stud-basis-table.ts";

export interface PlanSceneSource {
  readonly ldrawColor: LdrawColorOf;
  linearColors(): Float32Array;
  studBases(): StudBasisTable;
  changed(): void;
}

const BATCH_CHUNKS = 8;
const BATCH_LDU = BATCH_CHUNKS * CHUNK_LDU;
const QUARTER_TURN = Math.PI / 2;
const QUAD_POSITIONS = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];
const VEC4 = 4;
const LINE_VERTEX_FLOATS = 3;
const ALPHA_FLOOR = 1 / 255;
const DOT_MIN_PITCH_PX = 6;
const DOT_RING_INNER = 0.7;
const DOT_RING_SHADE = 0.6;
const SPRITE_RENDER_ORDER = 0;
const DOT_RENDER_ORDER = 1;
const LINE_RENDER_ORDER = 2;
const OUTLINE_COLOR = 0x262626;
const CENTRELINE_COLOR = 0xd96c1f;
const COLUMN_Y_X = 4;
const COLUMN_Y_Y = 5;
const COLUMN_Y_Z = 6;

interface StudShape {
  readonly top: number;
  readonly radius: number;
}

class Bounds {
  minX = Number.POSITIVE_INFINITY;
  minY = Number.POSITIVE_INFINITY;
  minZ = Number.POSITIVE_INFINITY;
  maxX = Number.NEGATIVE_INFINITY;
  maxY = Number.NEGATIVE_INFINITY;
  maxZ = Number.NEGATIVE_INFINITY;

  add(x: number, y: number, z: number): void {
    this.minX = Math.min(this.minX, x);
    this.minY = Math.min(this.minY, y);
    this.minZ = Math.min(this.minZ, z);
    this.maxX = Math.max(this.maxX, x);
    this.maxY = Math.max(this.maxY, y);
    this.maxZ = Math.max(this.maxZ, z);
  }

  sphereOf(geometry: InstancedBufferGeometry): void {
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    if (!sphere) return;
    sphere.center.set(
      (this.minX + this.maxX) / 2,
      (this.minY + this.maxY) / 2,
      (this.minZ + this.maxZ) / 2,
    );
    sphere.radius =
      Math.hypot(this.maxX - this.minX, this.maxY - this.minY, this.maxZ - this.minZ) / 2;
  }
}

function instancedQuad(
  count: number,
  attributes: Readonly<Record<string, Float32Array>>,
): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(new BufferAttribute(Uint16Array.from(QUAD_INDEX), 1));
  geometry.setAttribute("position", new Float32BufferAttribute(QUAD_POSITIONS, 3));
  for (const [name, values] of Object.entries(attributes)) {
    geometry.setAttribute(name, new InstancedBufferAttribute(values, VEC4));
  }
  geometry.instanceCount = count;
  return geometry;
}

function spriteMaterial(page: AtlasPage): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: true,
    side: DoubleSide,
    alphaTest: ALPHA_FLOOR / 2,
  });
  const corner = positionGeometry.xz;
  const box = attribute("spriteBox", "vec4");
  const pose = attribute("spritePose", "vec4");
  const rect = attribute("spriteRect", "vec4");
  const local = mix(box.xy, box.zw, corner);
  const turn = pose.w.mul(QUARTER_TURN);
  const c = round(cos(turn));
  const s = round(sin(turn));
  material.positionNode = vec3(
    pose.x.add(c.mul(local.x)).add(s.mul(local.y)),
    pose.z,
    pose.y.sub(s.mul(local.x)).add(c.mul(local.y)),
  );
  const texel = varying(rect.xy.add(corner.mul(rect.zw)).div(page.size));
  const sampled = texture(page.texture, texel);
  material.colorNode = sampled.rgb.div(max(sampled.a, float(ALPHA_FLOOR)));
  material.opacityNode = sampled.a;
  return material;
}

function dotMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    alphaTest: ALPHA_FLOOR / 2,
  });
  const corner = positionGeometry.xz;
  const centre = attribute("dotCentre", "vec4");
  const offset = corner.mul(2).sub(1);
  material.positionNode = vec3(
    centre.x.add(offset.x.mul(centre.w)),
    centre.y,
    centre.z.add(offset.y.mul(centre.w)),
  );
  const fromCentre = length(varying(offset));
  const edge = fwidth(fromCentre);
  const ring = smoothstep(float(DOT_RING_INNER).sub(edge), float(DOT_RING_INNER), fromCentre);
  const shade = varying(attribute("dotColor", "vec4").rgb);
  material.colorNode = mix(shade, shade.mul(DOT_RING_SHADE), ring);
  material.opacityNode = float(1).sub(smoothstep(float(1).sub(edge), float(1), fromCentre));
  return material;
}

function studShapeOf(primitive: StudPrimitiveAsset): StudShape {
  const { positions } = primitive.mesh;
  let top = 0;
  let radius = 0;
  for (let v = 0; v < positions.length; v += 3) {
    top = Math.max(top, positions[v + 1] ?? 0);
    radius = Math.max(radius, Math.hypot(positions[v] ?? 0, positions[v + 2] ?? 0));
  }
  return { top, radius };
}

function uprightStud(page: InstancePage, stud: number, columns: Float32Array): boolean {
  const basis = studBasisIndexOf(page.studBasisAndColorIndex[stud] ?? 0) * STUD_BASIS_FLOATS;
  return (
    columns[basis + COLUMN_Y_X] === 0 &&
    columns[basis + COLUMN_Y_Z] === 0 &&
    (columns[basis + COLUMN_Y_Y] ?? 0) > 0
  );
}

function placeSegments(
  page: InstancePage,
  part: number,
  lines: PlanPartLines,
  segments: Float32Array,
  offsetX: number,
  offsetZ: number,
  out: number[],
): void {
  const m = part * MATRIX4_FLOATS;
  const e = page.matrices;
  const y = lines.topY;
  for (let s = 0; s < segments.length; s += 2) {
    const x = segments[s] ?? 0;
    const z = segments[s + 1] ?? 0;
    out.push(
      offsetX + (e[m] ?? 0) * x + (e[m + 4] ?? 0) * y + (e[m + 8] ?? 0) * z + (e[m + 12] ?? 0),
      (e[m + 1] ?? 0) * x + (e[m + 5] ?? 0) * y + (e[m + 9] ?? 0) * z + (e[m + 13] ?? 0),
      offsetZ + (e[m + 2] ?? 0) * x + (e[m + 6] ?? 0) * y + (e[m + 10] ?? 0) * z + (e[m + 14] ?? 0),
    );
  }
}

class PlanBatch {
  readonly group = new Group();
  readonly placements = new Map<number, PlanInstances>();
  readonly parts = new Map<number, InstancePage>();
  dirty = false;

  constructor(
    readonly key: number,
    readonly originX: number,
    readonly originZ: number,
  ) {
    this.group.matrixAutoUpdate = false;
  }

  get empty(): boolean {
    return this.placements.size === 0 && this.parts.size === 0;
  }

  clear(): void {
    for (const child of this.group.children) {
      if (child instanceof Mesh || child instanceof LineSegments) child.geometry.dispose();
    }
    this.group.clear();
  }
}

export class PlanSceneBackend implements IPlanSceneBackend {
  readonly root = new Group();
  private readonly atlas = new GlyphAtlas();
  private readonly slots: Array<AtlasSlot | null | undefined> = [];
  private readonly unpacked: Array<readonly [number, PlanSprite]> = [];
  private readonly spriteMaterials: MeshBasicNodeMaterial[] = [];
  private readonly dots = dotMaterial();
  private readonly outlines = new LineBasicNodeMaterial({ color: OUTLINE_COLOR });
  private readonly centrelines = new LineBasicNodeMaterial({ color: CENTRELINE_COLOR });
  private readonly partLines: Array<PlanPartLines | undefined> = [];
  private studShapes: ReadonlyArray<StudShape> = [];
  private readonly batches = new Map<number, PlanBatch>();
  private readonly placementBatch = new Map<number, PlanBatch>();
  private readonly partBatch = new Map<number, PlanBatch>();
  private readonly dirty: PlanBatch[] = [];
  private renderOriginX = 0;
  private renderOriginZ = 0;
  private dotsShown = false;
  private readonly dotColor = new Color();

  constructor(private readonly source: PlanSceneSource) {
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
  }

  setSprite(id: number, sprite: PlanSprite): void {
    this.unpacked.push([id, sprite]);
    this.source.changed();
  }

  setPlacements(key: number, instances: PlanInstances): void {
    this.deletePlacements(key);
    const batch = this.batchAt(instances.originX, instances.originZ);
    batch.placements.set(key, instances);
    this.placementBatch.set(key, batch);
    this.markDirty(batch);
  }

  deletePlacements(key: number): void {
    const batch = this.placementBatch.get(key);
    if (!batch) return;
    batch.placements.delete(key);
    this.placementBatch.delete(key);
    this.markDirty(batch);
  }

  setPartLines(partIndex: number, lines: PlanPartLines): void {
    this.partLines[partIndex] = lines;
    for (const batch of this.batches.values()) this.markDirty(batch);
  }

  setStudPrimitives(primitives: ReadonlyArray<StudPrimitiveAsset>): void {
    this.studShapes = primitives.map(studShapeOf);
    for (const batch of this.batches.values()) this.markDirty(batch);
  }

  setPartPage(key: number, page: InstancePage | null): void {
    const previous = this.partBatch.get(key);
    if (previous) {
      previous.parts.delete(key);
      this.partBatch.delete(key);
      this.markDirty(previous);
    }
    if (!page) return;
    const batch = this.batchAt(page.originX, page.originZ);
    batch.parts.set(key, page);
    this.partBatch.set(key, batch);
    this.markDirty(batch);
  }

  clearPartPages(): void {
    for (const [key, batch] of this.partBatch) {
      batch.parts.delete(key);
      this.markDirty(batch);
    }
    this.partBatch.clear();
  }

  place(renderOriginX: number, renderOriginZ: number): void {
    this.renderOriginX = renderOriginX;
    this.renderOriginZ = renderOriginZ;
    for (const batch of this.batches.values()) this.placeBatch(batch);
  }

  prepare(studPitchPx: number): void {
    if (this.unpacked.length > 0) this.packSprites();
    for (let i = 0; i < this.dirty.length; i++) {
      const batch = this.dirty[i];
      if (batch) this.rebuild(batch);
    }
    this.dirty.length = 0;
    const shown = studPitchPx >= DOT_MIN_PITCH_PX;
    if (shown === this.dotsShown) return;
    this.dotsShown = shown;
    for (const batch of this.batches.values()) {
      for (const child of batch.group.children) {
        if (child instanceof Mesh && child.material === this.dots) child.visible = shown;
      }
    }
  }

  private packSprites(): void {
    for (const [id, sprite] of this.unpacked) {
      this.slots[id] = this.atlas.add(sprite, this.source.ldrawColor);
    }
    this.unpacked.length = 0;
    for (let page = this.spriteMaterials.length; page < this.atlas.pages.length; page++) {
      const atlasPage = this.atlas.pages[page];
      if (atlasPage) this.spriteMaterials.push(spriteMaterial(atlasPage));
    }
  }

  private batchAt(originX: number, originZ: number): PlanBatch {
    const batchX = Math.floor(originX / BATCH_LDU);
    const batchZ = Math.floor(originZ / BATCH_LDU);
    const key = chunkKey(batchX, batchZ);
    let batch = this.batches.get(key);
    if (!batch) {
      batch = new PlanBatch(key, batchX * BATCH_LDU, batchZ * BATCH_LDU);
      this.batches.set(key, batch);
      this.root.add(batch.group);
      this.placeBatch(batch);
    }
    return batch;
  }

  private placeBatch(batch: PlanBatch): void {
    batch.group.position.set(
      batch.originX - this.renderOriginX,
      0,
      batch.originZ - this.renderOriginZ,
    );
    batch.group.updateMatrix();
    batch.group.updateMatrixWorld(true);
  }

  private markDirty(batch: PlanBatch): void {
    this.source.changed();
    if (batch.dirty) return;
    batch.dirty = true;
    this.dirty.push(batch);
  }

  private rebuild(batch: PlanBatch): void {
    batch.dirty = false;
    batch.clear();
    if (batch.empty) {
      this.root.remove(batch.group);
      this.batches.delete(batch.key);
      return;
    }
    this.addSprites(batch);
    this.addDots(batch);
    this.addLines(batch);
    batch.group.updateMatrixWorld(true);
  }

  private slotOf(sprite: number): AtlasSlot | null {
    const slot = this.slots[sprite];
    if (slot === undefined) throw new Error(`plan sprite ${sprite} was never set`);
    return slot;
  }

  private addSprites(batch: PlanBatch): void {
    const sources = [...batch.placements.values()];
    let total = 0;
    for (const instances of sources) total += instances.count;
    const sourceOf = new Uint32Array(total);
    const instanceOf = new Uint32Array(total);
    const heights = new Float32Array(total);
    const perPage = new Uint32Array(this.spriteMaterials.length);
    let drawn = 0;
    for (let s = 0; s < sources.length; s++) {
      const instances = sources[s];
      if (!instances) continue;
      for (let i = 0; i < instances.count; i++) {
        const slot = this.slotOf(instances.sprite[i] ?? 0);
        if (!slot) continue;
        sourceOf[drawn] = s;
        instanceOf[drawn] = i;
        heights[drawn] = instances.pose[i * PLAN_POSE_FLOATS + PLAN_POSE_Y] ?? 0;
        perPage[slot.page] = (perPage[slot.page] ?? 0) + 1;
        drawn++;
      }
    }
    const order = new Uint32Array(drawn);
    for (let n = 0; n < drawn; n++) order[n] = n;
    order.sort((a, b) => (heights[a] ?? 0) - (heights[b] ?? 0) || a - b);
    for (let page = 0; page < perPage.length; page++) {
      const count = perPage[page] ?? 0;
      const material = this.spriteMaterials[page];
      if (count === 0 || !material) continue;
      const box = new Float32Array(count * VEC4);
      const pose = new Float32Array(count * VEC4);
      const rect = new Float32Array(count * VEC4);
      const bounds = new Bounds();
      let at = 0;
      for (let n = 0; n < drawn; n++) {
        const k = order[n] ?? 0;
        const instances = sources[sourceOf[k] ?? 0];
        const i = instanceOf[k] ?? 0;
        const slot = instances && this.slotOf(instances.sprite[i] ?? 0);
        if (!instances || !slot || slot.page !== page) continue;
        const p = i * PLAN_POSE_FLOATS;
        const x = instances.originX - batch.originX + (instances.pose[p + PLAN_POSE_X] ?? 0);
        const z = instances.originZ - batch.originZ + (instances.pose[p + PLAN_POSE_Z] ?? 0);
        const y = instances.pose[p + PLAN_POSE_Y] ?? 0;
        const rot = instances.pose[p + PLAN_POSE_ROT] ?? 0;
        const o = at * VEC4;
        box[o] = slot.minX;
        box[o + 1] = slot.minZ;
        box[o + 2] = slot.maxX;
        box[o + 3] = slot.maxZ;
        pose[o] = x;
        pose[o + 1] = z;
        pose[o + 2] = y;
        pose[o + 3] = rot;
        rect[o] = slot.texelX;
        rect[o + 1] = slot.texelY;
        rect[o + 2] = slot.width;
        rect[o + 3] = slot.depth;
        const c = Math.round(Math.cos(rot * QUARTER_TURN));
        const s = Math.round(Math.sin(rot * QUARTER_TURN));
        bounds.add(x + c * slot.minX + s * slot.minZ, y, z - s * slot.minX + c * slot.minZ);
        bounds.add(x + c * slot.maxX + s * slot.maxZ, y, z - s * slot.maxX + c * slot.maxZ);
        at++;
      }
      const geometry = instancedQuad(count, { spriteBox: box, spritePose: pose, spriteRect: rect });
      bounds.sphereOf(geometry);
      this.addMesh(batch, geometry, material, SPRITE_RENDER_ORDER, true);
    }
  }

  private addDots(batch: PlanBatch): void {
    const columns = this.source.studBases().columns;
    let count = 0;
    for (const page of batch.parts.values()) {
      for (let n = 0; n < page.instanceCount - page.partCount; n++) {
        if (uprightStud(page, n, columns)) count++;
      }
    }
    if (count === 0) return;
    const colors = this.source.linearColors();
    const centre = new Float32Array(count * VEC4);
    const color = new Float32Array(count * VEC4);
    const bounds = new Bounds();
    let at = 0;
    for (const page of batch.parts.values()) {
      const offsetX = page.originX - batch.originX;
      const offsetZ = page.originZ - batch.originZ;
      for (let n = 0; n < page.instanceCount - page.partCount; n++) {
        if (!uprightStud(page, n, columns)) continue;
        const shape = this.studShapes[page.shape[page.partCount + n] ?? 0];
        const packed = page.studBasisAndColorIndex[n] ?? 0;
        const basis = studBasisIndexOf(packed) * STUD_BASIS_FLOATS;
        const t = n * TRANSLATION_FLOATS;
        const radius = shape?.radius ?? 0;
        const x = offsetX + (page.studTranslations[t] ?? 0);
        const y =
          (page.studTranslations[t + 1] ?? 0) +
          (shape?.top ?? 0) * (columns[basis + COLUMN_Y_Y] ?? 0);
        const z = offsetZ + (page.studTranslations[t + 2] ?? 0);
        const o = at * VEC4;
        centre[o] = x;
        centre[o + 1] = y;
        centre[o + 2] = z;
        centre[o + 3] = radius;
        this.dotColor.fromArray(colors, (packed >>> STUD_COLOR_INDEX_SHIFT) * COLOR_CHANNELS);
        color[o] = this.dotColor.r;
        color[o + 1] = this.dotColor.g;
        color[o + 2] = this.dotColor.b;
        color[o + 3] = 1;
        bounds.add(x - radius, y, z - radius);
        bounds.add(x + radius, y, z + radius);
        at++;
      }
    }
    const geometry = instancedQuad(count, { dotCentre: centre, dotColor: color });
    bounds.sphereOf(geometry);
    this.addMesh(batch, geometry, this.dots, DOT_RENDER_ORDER, this.dotsShown);
  }

  private addMesh(
    batch: PlanBatch,
    geometry: InstancedBufferGeometry,
    material: MeshBasicNodeMaterial,
    renderOrder: number,
    visible: boolean,
  ): void {
    const mesh = new Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = renderOrder;
    mesh.visible = visible;
    batch.group.add(mesh);
  }

  private addLines(batch: PlanBatch): void {
    const outline: number[] = [];
    const centre: number[] = [];
    for (const page of batch.parts.values()) {
      const offsetX = page.originX - batch.originX;
      const offsetZ = page.originZ - batch.originZ;
      for (let n = 0; n < page.partCount; n++) {
        const lines = this.partLines[page.shape[n] ?? 0];
        if (!lines) continue;
        placeSegments(page, n, lines, lines.outline, offsetX, offsetZ, outline);
        placeSegments(page, n, lines, lines.centre, offsetX, offsetZ, centre);
      }
    }
    this.addLineSegments(batch, outline, this.outlines);
    this.addLineSegments(batch, centre, this.centrelines);
  }

  private addLineSegments(
    batch: PlanBatch,
    positions: ReadonlyArray<number>,
    material: LineBasicNodeMaterial,
  ): void {
    if (positions.length === 0) return;
    const geometry = new LineGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, LINE_VERTEX_FLOATS));
    const lines = new LineSegments(geometry, material);
    lines.matrixAutoUpdate = false;
    lines.renderOrder = LINE_RENDER_ORDER;
    batch.group.add(lines);
  }
}
