import { SUPER_CHUNK_LDU, isRot90, superChunkKey, type Rot90 } from "@brr/math";
import type { ISceneBackend, WorldBox } from "@brr/render";
import { IdleWorkLoop, type IdleWork } from "./idle-work-loop.ts";
import type { PlacedVoxels } from "./placed-voxels.ts";
import {
  SUPER_CHUNK_MESH_LEVELS,
  SuperChunkMesher,
  type VoxelStamp,
} from "./super-chunk-mesher.ts";

export interface VoxelPlacement {
  readonly box: WorldBox;
  readonly voxels: PlacedVoxels | null;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

export interface ChunkResidency {
  loadSuperChunk(superKey: number, deadlineMs: number): boolean;
  unloadSuperChunk(superKey: number): void;
}

export interface SuperChunkLodStats {
  superChunks: number;
  residentSuperChunks: number;
  meshedSuperChunks: number;
  staleSuperChunks: number;
  meshTriangles: number;
  lastBuildCpuMs: number;
  lastStaleMs: number;
  maxStaleMs: number;
  builds: number;
}

const DETAIL_ENTER_STUD_PX = 3;
const DETAIL_LEAVE_STUD_PX = 2.25;
const IDLE_SLICE_MS = 4;
const MAX_CELL_PX = 3;
const LEVEL_HYSTERESIS = 1.25;
const INDICES_PER_TRIANGLE = 3;

class SuperChunkState {
  readonly models: VoxelPlacement[] = [];
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  maxY = 0;
  unvoxelized = 0;
  wantsChunks: boolean;
  chunksLoaded = false;
  version = 0;
  level = 0;
  meshLevel = -1;
  meshVersion = -1;
  meshVisible = false;
  meshTriangles = 0;
  dirtySinceMs = 0;
  studPitchPx = 0;

  constructor(
    readonly key: number,
    readonly superX: number,
    readonly superZ: number,
    wantsChunks: boolean,
  ) {
    this.minX = superX * SUPER_CHUNK_LDU;
    this.minZ = superZ * SUPER_CHUNK_LDU;
    this.maxX = this.minX + SUPER_CHUNK_LDU;
    this.maxZ = this.minZ + SUPER_CHUNK_LDU;
    this.wantsChunks = wantsChunks;
  }

  get meshCurrent(): boolean {
    return this.meshVersion === this.version && this.meshLevel === this.level;
  }

  get meshBuilt(): boolean {
    return this.meshVersion >= 0;
  }

  touch(nowMs: number): void {
    if (this.meshCurrent) this.dirtySinceMs = nowMs;
    this.version++;
    let maxY = 0;
    let unvoxelized = 0;
    for (const model of this.models) {
      maxY = Math.max(maxY, model.box.maxY);
      if (!model.voxels) unvoxelized++;
    }
    this.maxY = maxY;
    this.unvoxelized = unvoxelized;
  }
}

interface MeshJob {
  readonly state: SuperChunkState;
  readonly version: number;
  readonly level: number;
  cpuMs: number;
}

function levelFor(studPitchPx: number): number {
  const level = Math.floor(Math.log2(MAX_CELL_PX / Math.max(studPitchPx, Number.MIN_VALUE)));
  return Math.min(Math.max(level, 0), SUPER_CHUNK_MESH_LEVELS - 1);
}

function superOf(ldu: number): number {
  return Math.floor(ldu / SUPER_CHUNK_LDU);
}

function rot90(rot: number): Rot90 {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  return rot;
}

export class SuperChunkLod implements IdleWork {
  private readonly states = new Map<number, SuperChunkState>();
  private stateList: SuperChunkState[] = [];
  private readonly mesher = new SuperChunkMesher();
  private job: MeshJob | null = null;
  private eyeX = 0;
  private eyeY = 0;
  private eyeZ = 0;
  private enabled = true;
  private readonly idle = new IdleWorkLoop(this, IDLE_SLICE_MS);
  readonly stats: SuperChunkLodStats = {
    superChunks: 0,
    residentSuperChunks: 0,
    meshedSuperChunks: 0,
    staleSuperChunks: 0,
    meshTriangles: 0,
    lastBuildCpuMs: 0,
    lastStaleMs: 0,
    maxStaleMs: 0,
    builds: 0,
  };

  constructor(
    private readonly backend: ISceneBackend,
    private readonly residency: ChunkResidency,
  ) {}

  setEnabled(enabled: boolean): void {
    if (this.stateList.length > 0)
      throw new Error("the super-chunk LOD is fixed once models are placed");
    this.enabled = enabled;
  }

  get settled(): boolean {
    for (let i = 0; i < this.stateList.length; i++) {
      const state = this.stateList[i];
      if (!state) continue;
      if (state.wantsChunks && !state.chunksLoaded) return false;
      if (this.enabled && !state.meshCurrent) return false;
    }
    return true;
  }

  private wantsDetail(state: SuperChunkState, pitchPx: number): boolean {
    if (!this.enabled || state.unvoxelized > 0) return true;
    return state.wantsChunks ? pitchPx >= DETAIL_LEAVE_STUD_PX : pitchPx >= DETAIL_ENTER_STUD_PX;
  }

  isResident(superKey: number): boolean {
    return this.states.get(superKey)?.wantsChunks ?? false;
  }

  add(model: VoxelPlacement): void {
    const now = performance.now();
    this.forEachSuper(model.box, (superX, superZ) => {
      const state = this.stateAt(superX, superZ);
      state.models.push(model);
      state.touch(now);
    });
    if (this.enabled) this.idle.wake();
  }

  remove(model: VoxelPlacement): void {
    const now = performance.now();
    this.forEachSuper(model.box, (superX, superZ) => {
      const key = superChunkKey(superX, superZ);
      const state = this.states.get(key);
      if (!state) return;
      const index = state.models.indexOf(model);
      if (index >= 0) state.models.splice(index, 1);
      state.touch(now);
      if (state.models.length === 0) this.drop(state);
    });
    if (this.enabled) this.idle.wake();
  }

  work(deadlineMs: number): boolean {
    this.buildMeshes(deadlineMs);
    return this.job !== null || this.nextToMesh() !== null;
  }

  private forEachSuper(box: WorldBox, visit: (superX: number, superZ: number) => void): void {
    const loX = superOf(box.minX);
    const hiX = superOf(box.maxX);
    const loZ = superOf(box.minZ);
    const hiZ = superOf(box.maxZ);
    for (let superX = loX; superX <= hiX; superX++) {
      for (let superZ = loZ; superZ <= hiZ; superZ++) visit(superX, superZ);
    }
  }

  private stateAt(superX: number, superZ: number): SuperChunkState {
    const key = superChunkKey(superX, superZ);
    const existing = this.states.get(key);
    if (existing) return existing;
    const state = new SuperChunkState(key, superX, superZ, false);
    state.wantsChunks = this.wantsDetail(state, this.studPitchPx(state));
    this.states.set(key, state);
    this.stateList.push(state);
    return state;
  }

  private drop(state: SuperChunkState): void {
    if (this.job?.state === state) this.job = null;
    this.backend.deleteSuperChunk(state.key);
    this.states.delete(state.key);
    this.stateList = this.stateList.filter((s) => s !== state);
  }

  private studPitchPx(state: SuperChunkState): number {
    const dx = Math.max(state.minX - this.eyeX, 0, this.eyeX - state.maxX);
    const dz = Math.max(state.minZ - this.eyeZ, 0, this.eyeZ - state.maxZ);
    const dy = Math.max(-this.eyeY, 0, this.eyeY - state.maxY);
    return this.backend.studPitchPx(Math.hypot(dx, dy, dz));
  }

  update(eyeX: number, eyeY: number, eyeZ: number, deadlineMs: number): void {
    this.eyeX = eyeX;
    this.eyeY = eyeY;
    this.eyeZ = eyeZ;
    for (let i = 0; i < this.stateList.length; i++) {
      const state = this.stateList[i];
      if (state) this.retier(state);
    }
    this.loadChunks(deadlineMs);
    this.tally();
  }

  private releveled(state: SuperChunkState, pitch: number): void {
    const finer = levelFor(pitch * LEVEL_HYSTERESIS);
    const coarser = levelFor(pitch / LEVEL_HYSTERESIS);
    if (state.level >= finer && state.level <= coarser) return;
    const now = performance.now();
    if (state.meshCurrent) state.dirtySinceMs = now;
    state.level = levelFor(pitch);
    if (this.enabled) this.idle.wake();
  }

  private retier(state: SuperChunkState): void {
    const pitch = this.studPitchPx(state);
    state.studPitchPx = pitch;
    this.releveled(state, pitch);
    const wants = this.wantsDetail(state, pitch);
    if (wants === state.wantsChunks) return;
    if (wants) {
      state.wantsChunks = true;
      return;
    }
    if (!state.meshBuilt || state.meshVersion !== state.version) return;
    state.wantsChunks = false;
    state.chunksLoaded = false;
    this.showMesh(state, true);
    this.residency.unloadSuperChunk(state.key);
  }

  private showMesh(state: SuperChunkState, visible: boolean): void {
    if (state.meshVisible === visible) return;
    state.meshVisible = visible;
    this.backend.setSuperChunkVisible(state.key, visible);
  }

  private loadChunks(deadlineMs: number): void {
    for (let i = 0; i < this.stateList.length; i++) {
      const state = this.stateList[i];
      if (!state || !state.wantsChunks || state.chunksLoaded) continue;
      if (performance.now() >= deadlineMs) return;
      state.chunksLoaded = this.residency.loadSuperChunk(state.key, deadlineMs);
      if (state.chunksLoaded) this.showMesh(state, false);
    }
  }

  private nextToMesh(): SuperChunkState | null {
    let best: SuperChunkState | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.stateList.length; i++) {
      const state = this.stateList[i];
      if (!state || state.meshCurrent) continue;
      const urgent =
        !state.wantsChunks || !state.chunksLoaded || state.studPitchPx < DETAIL_LEAVE_STUD_PX
          ? 1
          : 0;
      const score = urgent * 1e9 - state.dirtySinceMs;
      if (score > bestScore) {
        bestScore = score;
        best = state;
      }
    }
    return best;
  }

  private buildMeshes(deadlineMs: number): void {
    while (performance.now() < deadlineMs) {
      if (!this.job) {
        const state = this.nextToMesh();
        if (!state) return;
        this.beginJob(state);
      }
      const job = this.job;
      if (!job) return;
      const sliceStart = performance.now();
      const finished = this.mesher.step(deadlineMs);
      job.cpuMs += performance.now() - sliceStart;
      if (!finished) return;
      this.finishJob(job);
    }
  }

  private beginJob(state: SuperChunkState): void {
    const beganMs = performance.now();
    const stamps: VoxelStamp[] = [];
    for (const model of state.models) {
      if (!model.voxels) continue;
      stamps.push({
        voxels: model.voxels,
        x: model.x,
        z: model.z,
        yPlates: model.yPlates,
        rot: rot90(model.rot),
      });
    }
    this.mesher.begin(state.superX, state.superZ, stamps, state.level);
    this.job = {
      state,
      version: state.version,
      level: state.level,
      cpuMs: performance.now() - beganMs,
    };
  }

  private finishJob(job: MeshJob): void {
    this.job = null;
    const uploadStart = performance.now();
    const arrays = this.mesher.finish();
    const { state } = job;
    this.backend.setSuperChunk(state.key, {
      originX: state.minX,
      originZ: state.minZ,
      ...arrays,
    });
    state.meshVersion = job.version;
    state.meshLevel = job.level;
    state.meshTriangles = arrays.indexCount / INDICES_PER_TRIANGLE;
    if (!state.wantsChunks || !state.chunksLoaded) this.showMesh(state, true);
    const now = performance.now();
    job.cpuMs += now - uploadStart;
    const stats = this.stats;
    stats.builds++;
    stats.lastBuildCpuMs = job.cpuMs;
    if (state.meshCurrent && !state.wantsChunks) {
      stats.lastStaleMs = now - state.dirtySinceMs;
      stats.maxStaleMs = Math.max(stats.maxStaleMs, stats.lastStaleMs);
    }
  }

  private tally(): void {
    let resident = 0;
    let meshed = 0;
    let stale = 0;
    let triangles = 0;
    for (let i = 0; i < this.stateList.length; i++) {
      const state = this.stateList[i];
      if (!state) continue;
      if (state.wantsChunks) resident++;
      if (state.meshVisible) {
        meshed++;
        triangles += state.meshTriangles;
      }
      if (!state.meshCurrent) stale++;
    }
    const stats = this.stats;
    stats.superChunks = this.stateList.length;
    stats.residentSuperChunks = resident;
    stats.meshedSuperChunks = meshed;
    stats.staleSuperChunks = stale;
    stats.meshTriangles = triangles;
  }
}
