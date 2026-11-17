import {
  BatchedMesh,
  Box3,
  Group,
  type BufferGeometry,
  type Color,
  type Material,
  type Matrix4,
} from "three/webgpu";

const INITIAL_INSTANCES = 1024;
const INITIAL_VERTICES = 1 << 14;
const INDICES_PER_VERTEX = 3;
const INSTANCE_GROWTH = 2;
const GEOMETRY_GROWTH = 1.25;
const INITIAL_GROUP = 64;

export const NO_INSTANCE = -1;

function descending(a: number, b: number): number {
  return b - a;
}

function grown(capacity: number, needed: number, growth: number): number {
  return Math.max(needed, Math.ceil(capacity * growth));
}

class GeometryBatch {
  readonly mesh: BatchedMesh;
  private readonly geometryIds = new Map<BufferGeometry, number>();
  private vertexCapacity = INITIAL_VERTICES;
  private indexCapacity = INITIAL_VERTICES * INDICES_PER_VERTEX;
  private usedVertices = 0;
  private usedIndices = 0;
  private parked = new Int32Array(INITIAL_INSTANCES);
  private parkedCount = 0;

  constructor(material: Material) {
    this.mesh = new BatchedMesh(
      INITIAL_INSTANCES,
      this.vertexCapacity,
      this.indexCapacity,
      material,
    );
    this.mesh.perObjectFrustumCulled = false;
    this.mesh.sortObjects = false;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  geometryId(geometry: BufferGeometry): number {
    const existing = this.geometryIds.get(geometry);
    if (existing !== undefined) return existing;
    const vertices = geometry.getAttribute("position").count;
    const indices = geometry.getIndex()?.count ?? 0;
    const neededVertices = this.usedVertices + vertices;
    const neededIndices = this.usedIndices + indices;
    if (neededVertices > this.vertexCapacity || neededIndices > this.indexCapacity) {
      this.vertexCapacity = grown(this.vertexCapacity, neededVertices, GEOMETRY_GROWTH);
      this.indexCapacity = grown(this.indexCapacity, neededIndices, GEOMETRY_GROWTH);
      this.mesh.setGeometrySize(this.vertexCapacity, this.indexCapacity);
    }
    const id = this.mesh.addGeometry(geometry);
    this.usedVertices = neededVertices;
    this.usedIndices = neededIndices;
    this.geometryIds.set(geometry, id);
    return id;
  }

  prepare(): void {
    this.parked.set(this.parked.subarray(0, this.parkedCount).toSorted(descending));
  }

  addInstance(geometryId: number, matrix: Matrix4, color: Color | null): number {
    const mesh = this.mesh;
    let id: number;
    if (this.parkedCount > 0) {
      this.parkedCount--;
      id = this.parked[this.parkedCount] ?? NO_INSTANCE;
      mesh.setGeometryIdAt(id, geometryId);
      mesh.setVisibleAt(id, true);
    } else {
      if (mesh.instanceCount >= mesh.maxInstanceCount) {
        mesh.setInstanceCount(
          grown(mesh.maxInstanceCount, mesh.maxInstanceCount + 1, INSTANCE_GROWTH),
        );
      }
      id = mesh.addInstance(geometryId);
    }
    mesh.setMatrixAt(id, matrix);
    if (color) mesh.setColorAt(id, color);
    return id;
  }

  park(id: number): void {
    if (this.parkedCount === this.parked.length) {
      const next = new Int32Array(this.parked.length * INSTANCE_GROWTH);
      next.set(this.parked);
      this.parked = next;
    }
    this.mesh.setVisibleAt(id, false);
    this.parked[this.parkedCount] = id;
    this.parkedCount++;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

export class InstanceGroup {
  constructor(
    readonly slots: Uint16Array,
    readonly ids: Int32Array,
  ) {}
}

export const EMPTY_GROUP = new InstanceGroup(new Uint16Array(0), new Int32Array(0));

export class GroupBuilder {
  private slots = new Uint16Array(INITIAL_GROUP);
  private ids = new Int32Array(INITIAL_GROUP);
  private count = 0;

  push(slot: number, id: number): void {
    if (this.count === this.ids.length) {
      const slots = new Uint16Array(this.count * INSTANCE_GROWTH);
      const ids = new Int32Array(this.count * INSTANCE_GROWTH);
      slots.set(this.slots);
      ids.set(this.ids);
      this.slots = slots;
      this.ids = ids;
    }
    this.slots[this.count] = slot;
    this.ids[this.count] = id;
    this.count++;
  }

  build(): InstanceGroup {
    if (this.count === 0) return EMPTY_GROUP;
    return new InstanceGroup(this.slots.slice(0, this.count), this.ids.slice(0, this.count));
  }
}

export interface BatchStyle {
  readonly layer: number | null;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
}

export class BatchSet {
  readonly root = new Group();
  private readonly batches: GeometryBatch[] = [];
  private readonly slotOf = new Map<Material, number>();

  constructor(private readonly style: BatchStyle) {
    this.root.matrixAutoUpdate = false;
  }

  prepare(): void {
    for (let b = 0; b < this.batches.length; b++) this.batches[b]?.prepare();
  }

  add(
    material: Material,
    geometry: BufferGeometry,
    matrix: Matrix4,
    color: Color | null,
    out: GroupBuilder,
  ): void {
    const slot = this.slot(material);
    const batch = this.batches[slot];
    if (!batch) throw new Error(`batch slot ${slot} is missing`);
    out.push(slot, batch.addInstance(batch.geometryId(geometry), matrix, color));
  }

  private slot(material: Material): number {
    const existing = this.slotOf.get(material);
    if (existing !== undefined) return existing;
    const batch = new GeometryBatch(material);
    const { mesh } = batch;
    mesh.castShadow = this.style.castShadow;
    mesh.receiveShadow = this.style.receiveShadow && !material.transparent;
    if (this.style.layer !== null) mesh.layers.set(this.style.layer);
    this.root.add(mesh);
    this.batches.push(batch);
    this.slotOf.set(material, this.batches.length - 1);
    return this.batches.length - 1;
  }

  setGroupVisible(group: InstanceGroup, visible: boolean): void {
    for (let i = 0; i < group.ids.length; i++) {
      this.batches[group.slots[i] ?? 0]?.mesh.setVisibleAt(group.ids[i] ?? 0, visible);
    }
  }

  releaseGroup(group: InstanceGroup): void {
    for (let i = 0; i < group.ids.length; i++) {
      this.batches[group.slots[i] ?? 0]?.park(group.ids[i] ?? 0);
    }
  }

  dispose(): void {
    for (const batch of this.batches) batch.dispose();
  }
}

export class RegionBatches {
  readonly root = new Group();
  readonly casterRoot = new Group();
  readonly chunks = new Set<number>();
  readonly bounds = new Box3();
  readonly near: BatchSet;
  private shellSet: BatchSet | undefined;
  private casterSet: BatchSet | undefined;
  private nearChunks = 0;

  constructor(
    readonly originX: number,
    readonly originZ: number,
    private readonly visibleStyle: BatchStyle,
    private readonly casterStyle: BatchStyle,
  ) {
    this.near = new BatchSet(visibleStyle);
    this.root.matrixAutoUpdate = false;
    this.casterRoot.matrixAutoUpdate = false;
    this.root.add(this.near.root);
  }

  shell(): BatchSet {
    if (!this.shellSet) {
      this.shellSet = new BatchSet(this.visibleStyle);
      this.root.add(this.shellSet.root);
      this.showSets();
    }
    return this.shellSet;
  }

  casters(): BatchSet {
    if (!this.casterSet) {
      this.casterSet = new BatchSet(this.casterStyle);
      this.casterRoot.add(this.casterSet.root);
    }
    return this.casterSet;
  }

  countNear(change: number): void {
    this.nearChunks += change;
    this.showSets();
  }

  showSets(): void {
    this.near.root.visible = this.nearChunks > 0;
    if (this.shellSet) this.shellSet.root.visible = this.chunks.size > this.nearChunks;
  }

  dispose(): void {
    this.near.dispose();
    this.shellSet?.dispose();
    this.casterSet?.dispose();
  }
}
