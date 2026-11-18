import { COLOR_CHANNELS, INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "../scene-backend.ts";

export const MATRIX4_FLOATS = 16;
export const TRANSLATION_X = 12;
export const TRANSLATION_Z = 14;

export function writeMatrix4(
  source: Float32Array,
  sourceIndex: number,
  target: Float32Array,
  targetIndex: number,
): void {
  const s = sourceIndex * INSTANCE_MATRIX_FLOATS;
  const t = targetIndex * MATRIX4_FLOATS;
  target[t] = source[s] ?? 0;
  target[t + 1] = source[s + 4] ?? 0;
  target[t + 2] = source[s + 8] ?? 0;
  target[t + 3] = 0;
  target[t + 4] = source[s + 1] ?? 0;
  target[t + 5] = source[s + 5] ?? 0;
  target[t + 6] = source[s + 9] ?? 0;
  target[t + 7] = 0;
  target[t + 8] = source[s + 2] ?? 0;
  target[t + 9] = source[s + 6] ?? 0;
  target[t + 10] = source[s + 10] ?? 0;
  target[t + 11] = 0;
  target[t + 12] = source[s + 3] ?? 0;
  target[t + 13] = source[s + 7] ?? 0;
  target[t + 14] = source[s + 11] ?? 0;
  target[t + 15] = 1;
}

const CLASS_NOT_UPRIGHT = 1;
const CLASS_VOXELIZED = 2;
const UPRIGHT_TOLERANCE = 1e-6;

export interface InstanceRuns {
  readonly shape: Uint16Array;
  readonly alphaSlot: Uint8Array;
  readonly instanceClass: Uint8Array;
  readonly start: Uint32Array;
  readonly end: Uint32Array;
}

export interface InstancePage {
  readonly originX: number;
  readonly originZ: number;
  readonly partCount: number;
  readonly instanceCount: number;
  readonly matrices: Float32Array;
  readonly linearColors: Float32Array;
  readonly colorIndex: Uint16Array;
  readonly shape: Uint16Array;
  readonly voxelized: Uint8Array;
  readonly partRuns: InstanceRuns;
  readonly studRuns: InstanceRuns;
}

export interface RegionPage extends InstancePage {
  readonly chunkKeys: Float64Array;
  readonly chunkIndex: Uint8Array;
}

const CHUNK_INDEX_LIMIT = 256;
const NOT_KEPT = -1;

interface InstanceColumns {
  readonly matrices: Float32Array;
  readonly shape: ArrayLike<number>;
  readonly colorIndex: ArrayLike<number>;
}

interface InstanceSource extends InstanceColumns {
  readonly count: number;
  readonly voxelized: ArrayLike<number> | null;
}

interface OrderedPage {
  readonly page: InstancePage;
  readonly partOrder: Uint32Array;
  readonly studOrder: Uint32Array;
}

export function isNotUpright(instanceClass: number): boolean {
  return (instanceClass & CLASS_NOT_UPRIGHT) !== 0;
}

export function isVoxelized(instanceClass: number): boolean {
  return (instanceClass & CLASS_VOXELIZED) !== 0;
}

function isUpright(matrices: Float32Array, i: number): boolean {
  const o = i * MATRIX4_FLOATS;
  return (
    Math.abs(matrices[o + 4] ?? 0) < UPRIGHT_TOLERANCE &&
    Math.abs(matrices[o + 6] ?? 0) < UPRIGHT_TOLERANCE &&
    Math.abs(matrices[o + 1] ?? 0) < UPRIGHT_TOLERANCE &&
    Math.abs(matrices[o + 9] ?? 0) < UPRIGHT_TOLERANCE &&
    Math.abs((matrices[o + 5] ?? 0) - 1) < UPRIGHT_TOLERANCE
  );
}

function classesOf(source: InstanceSource): Uint8Array {
  const classes = new Uint8Array(source.count);
  if (!source.voxelized) return classes;
  for (let i = 0; i < source.count; i++) {
    const voxelized = (source.voxelized[i] ?? 0) !== 0 ? CLASS_VOXELIZED : 0;
    classes[i] = voxelized | (isUpright(source.matrices, i) ? 0 : CLASS_NOT_UPRIGHT);
  }
  return classes;
}

function slotsOf(source: InstanceSource, colorAlphaSlot: Uint8Array): Uint8Array {
  const slots = new Uint8Array(source.count);
  for (let i = 0; i < source.count; i++) slots[i] = colorAlphaSlot[source.colorIndex[i] ?? 0] ?? 0;
  return slots;
}

function drawOrder(source: InstanceSource, slots: Uint8Array, classes: Uint8Array): Uint32Array {
  const order = new Uint32Array(source.count);
  for (let i = 0; i < source.count; i++) order[i] = i;
  const { shape } = source;
  return order.toSorted(
    (a, b) =>
      (shape[a] ?? 0) - (shape[b] ?? 0) ||
      (slots[a] ?? 0) - (slots[b] ?? 0) ||
      (classes[a] ?? 0) - (classes[b] ?? 0) ||
      a - b,
  );
}

function sameRun(
  source: InstanceSource,
  slots: Uint8Array,
  classes: Uint8Array,
  a: number,
  b: number,
): boolean {
  return source.shape[a] === source.shape[b] && slots[a] === slots[b] && classes[a] === classes[b];
}

function runsOf(
  source: InstanceSource,
  order: Uint32Array,
  slots: Uint8Array,
  classes: Uint8Array,
  pageOffset: number,
): InstanceRuns {
  let count = 0;
  for (let n = 0; n < order.length; n++) {
    if (n === 0 || !sameRun(source, slots, classes, order[n] ?? 0, order[n - 1] ?? 0)) count++;
  }
  const runs: InstanceRuns = {
    shape: new Uint16Array(count),
    alphaSlot: new Uint8Array(count),
    instanceClass: new Uint8Array(count),
    start: new Uint32Array(count),
    end: new Uint32Array(count),
  };
  let run = -1;
  for (let n = 0; n < order.length; n++) {
    const i = order[n] ?? 0;
    if (n === 0 || !sameRun(source, slots, classes, i, order[n - 1] ?? 0)) {
      run++;
      runs.shape[run] = source.shape[i] ?? 0;
      runs.alphaSlot[run] = slots[i] ?? 0;
      runs.instanceClass[run] = classes[i] ?? 0;
      runs.start[run] = pageOffset + n;
    }
    runs.end[run] = pageOffset + n + 1;
  }
  return runs;
}

function copyInstances(
  source: InstanceSource,
  order: Uint32Array,
  linearColors: Float32Array,
  page: InstancePage,
  pageOffset: number,
): void {
  for (let n = 0; n < order.length; n++) {
    const i = order[n] ?? 0;
    const to = pageOffset + n;
    for (let f = 0; f < MATRIX4_FLOATS; f++) {
      page.matrices[to * MATRIX4_FLOATS + f] = source.matrices[i * MATRIX4_FLOATS + f] ?? 0;
    }
    const color = source.colorIndex[i] ?? 0;
    for (let channel = 0; channel < COLOR_CHANNELS; channel++) {
      page.linearColors[to * COLOR_CHANNELS + channel] =
        linearColors[color * COLOR_CHANNELS + channel] ?? 0;
    }
    page.colorIndex[to] = color;
    page.shape[to] = source.shape[i] ?? 0;
    if (to < page.partCount) page.voxelized[to] = source.voxelized?.[i] ?? 0;
  }
}

function build(
  originX: number,
  originZ: number,
  parts: InstanceSource,
  studs: InstanceSource,
  linearColors: Float32Array,
  colorAlphaSlot: Uint8Array,
): OrderedPage {
  const instanceCount = parts.count + studs.count;
  const partSlots = slotsOf(parts, colorAlphaSlot);
  const partClasses = classesOf(parts);
  const partOrder = drawOrder(parts, partSlots, partClasses);
  const studSlots = slotsOf(studs, colorAlphaSlot);
  const studClasses = classesOf(studs);
  const studOrder = drawOrder(studs, studSlots, studClasses);
  const page: InstancePage = {
    originX,
    originZ,
    partCount: parts.count,
    instanceCount,
    matrices: new Float32Array(instanceCount * MATRIX4_FLOATS),
    linearColors: new Float32Array(instanceCount * COLOR_CHANNELS),
    colorIndex: new Uint16Array(instanceCount),
    shape: new Uint16Array(instanceCount),
    voxelized: new Uint8Array(parts.count),
    partRuns: runsOf(parts, partOrder, partSlots, partClasses, 0),
    studRuns: runsOf(studs, studOrder, studSlots, studClasses, parts.count),
  };
  copyInstances(parts, partOrder, linearColors, page, 0);
  copyInstances(studs, studOrder, linearColors, page, parts.count);
  return { page, partOrder, studOrder };
}

function matrix4Of(source: Float32Array, count: number): Float32Array {
  const matrices = new Float32Array(count * MATRIX4_FLOATS);
  for (let i = 0; i < count; i++) writeMatrix4(source, i, matrices, i);
  return matrices;
}

function partsOf(instances: ChunkInstances): InstanceSource {
  return {
    count: instances.count,
    matrices: matrix4Of(instances.matrices, instances.count),
    shape: instances.partIndex,
    colorIndex: instances.colorIndex,
    voxelized: instances.voxelized ?? new Uint8Array(instances.count),
  };
}

function studsOf(instances: ChunkInstances): InstanceSource {
  const { studs } = instances;
  return {
    count: studs.count,
    matrices: matrix4Of(studs.matrices, studs.count),
    shape: studs.primitiveIndex,
    colorIndex: studs.colorIndex,
    voxelized: null,
  };
}

export function pageOf(
  instances: ChunkInstances,
  linearColors: Float32Array,
  colorAlphaSlot: Uint8Array,
): InstancePage {
  return build(
    instances.originX,
    instances.originZ,
    partsOf(instances),
    studsOf(instances),
    linearColors,
    colorAlphaSlot,
  ).page;
}

export function regroupedPage(
  page: InstancePage,
  linearColors: Float32Array,
  colorAlphaSlot: Uint8Array,
): InstancePage {
  const parts = page.partCount;
  return build(
    page.originX,
    page.originZ,
    {
      count: parts,
      matrices: page.matrices,
      shape: page.shape,
      colorIndex: page.colorIndex,
      voxelized: page.voxelized,
    },
    {
      count: page.instanceCount - parts,
      matrices: page.matrices.subarray(parts * MATRIX4_FLOATS),
      shape: page.shape.subarray(parts),
      colorIndex: page.colorIndex.subarray(parts),
      voxelized: null,
    },
    linearColors,
    colorAlphaSlot,
  ).page;
}

function memberKeys(
  previous: RegionPage | null,
  changes: ReadonlyMap<number, ChunkInstances | null>,
): Float64Array {
  const keys: number[] = [];
  if (previous) {
    for (let m = 0; m < previous.chunkKeys.length; m++) {
      const key = previous.chunkKeys[m] ?? 0;
      if (!changes.has(key)) keys.push(key);
    }
  }
  for (const [key, chunk] of changes) if (chunk) keys.push(key);
  if (keys.length > CHUNK_INDEX_LIMIT) {
    throw new RangeError(
      `a region page holds at most ${CHUNK_INDEX_LIMIT} chunks, not ${keys.length}`,
    );
  }
  return Float64Array.from(keys).toSorted();
}

interface RegionColumns {
  readonly matrices: Float32Array;
  readonly shape: Uint16Array;
  readonly colorIndex: Uint16Array;
  readonly voxelized: Uint8Array | null;
  readonly chunkIndex: Uint8Array;
}

function copyIntoRegion(
  target: RegionColumns,
  to: number,
  from: InstanceColumns,
  i: number,
  voxelized: number,
  chunkIndex: number,
  offsetX: number,
  offsetZ: number,
): void {
  const t = to * MATRIX4_FLOATS;
  target.matrices.set(from.matrices.subarray(i * MATRIX4_FLOATS, (i + 1) * MATRIX4_FLOATS), t);
  target.matrices[t + TRANSLATION_X] = (target.matrices[t + TRANSLATION_X] ?? 0) + offsetX;
  target.matrices[t + TRANSLATION_Z] = (target.matrices[t + TRANSLATION_Z] ?? 0) + offsetZ;
  target.shape[to] = from.shape[i] ?? 0;
  target.colorIndex[to] = from.colorIndex[i] ?? 0;
  if (target.voxelized) target.voxelized[to] = voxelized;
  target.chunkIndex[to] = chunkIndex;
}

function regionSource(
  keys: Float64Array,
  previous: RegionPage | null,
  first: number,
  end: number,
  changed: ReadonlyArray<InstanceSource | null>,
  offsetX: Float64Array,
  offsetZ: Float64Array,
  isParts: boolean,
): InstanceSource & RegionColumns {
  const keptAs = new Int16Array(previous?.chunkKeys.length ?? 0).fill(NOT_KEPT);
  for (let m = 0; m < keys.length; m++) {
    if (previous && !changed[m]) keptAs[previous.chunkKeys.indexOf(keys[m] ?? 0)] = m;
  }
  const next = new Uint32Array(keys.length + 1);
  for (let m = 0; m < keys.length; m++) next[m + 1] = changed[m]?.count ?? 0;
  for (let i = first; i < end; i++) {
    const m = keptAs[previous?.chunkIndex[i] ?? 0] ?? NOT_KEPT;
    if (m !== NOT_KEPT) next[m + 1] = (next[m + 1] ?? 0) + 1;
  }
  for (let m = 1; m <= keys.length; m++) next[m] = (next[m] ?? 0) + (next[m - 1] ?? 0);
  const count = next[keys.length] ?? 0;
  const source = {
    count,
    matrices: new Float32Array(count * MATRIX4_FLOATS),
    shape: new Uint16Array(count),
    colorIndex: new Uint16Array(count),
    voxelized: isParts ? new Uint8Array(count) : null,
    chunkIndex: new Uint8Array(count),
  };
  if (previous) {
    for (let i = first; i < end; i++) {
      const m = keptAs[previous.chunkIndex[i] ?? 0] ?? NOT_KEPT;
      if (m === NOT_KEPT) continue;
      const to = next[m] ?? 0;
      next[m] = to + 1;
      copyIntoRegion(source, to, previous, i, previous.voxelized[i] ?? 0, m, 0, 0);
    }
  }
  for (let m = 0; m < keys.length; m++) {
    const from = changed[m];
    if (!from) continue;
    for (let i = 0; i < from.count; i++) {
      const to = next[m] ?? 0;
      next[m] = to + 1;
      const voxelized = from.voxelized?.[i] ?? 0;
      copyIntoRegion(source, to, from, i, voxelized, m, offsetX[m] ?? 0, offsetZ[m] ?? 0);
    }
  }
  return source;
}

export function regionPage(
  previous: RegionPage | null,
  changes: ReadonlyMap<number, ChunkInstances | null>,
  originX: number,
  originZ: number,
  linearColors: Float32Array,
  colorAlphaSlot: Uint8Array,
): RegionPage | null {
  const keys = memberKeys(previous, changes);
  if (keys.length === 0) return null;
  const changedParts: Array<InstanceSource | null> = [];
  const changedStuds: Array<InstanceSource | null> = [];
  const offsetX = new Float64Array(keys.length);
  const offsetZ = new Float64Array(keys.length);
  for (let m = 0; m < keys.length; m++) {
    const chunk = changes.get(keys[m] ?? 0);
    changedParts.push(chunk ? partsOf(chunk) : null);
    changedStuds.push(chunk ? studsOf(chunk) : null);
    offsetX[m] = chunk ? chunk.originX - originX : 0;
    offsetZ[m] = chunk ? chunk.originZ - originZ : 0;
  }
  const partCount = previous?.partCount ?? 0;
  const instanceCount = previous?.instanceCount ?? 0;
  const parts = regionSource(keys, previous, 0, partCount, changedParts, offsetX, offsetZ, true);
  const studs = regionSource(
    keys,
    previous,
    partCount,
    instanceCount,
    changedStuds,
    offsetX,
    offsetZ,
    false,
  );
  const { page, partOrder, studOrder } = build(
    originX,
    originZ,
    parts,
    studs,
    linearColors,
    colorAlphaSlot,
  );
  const chunkIndex = new Uint8Array(page.instanceCount);
  for (let n = 0; n < partOrder.length; n++) {
    chunkIndex[n] = parts.chunkIndex[partOrder[n] ?? 0] ?? 0;
  }
  for (let n = 0; n < studOrder.length; n++) {
    chunkIndex[page.partCount + n] = studs.chunkIndex[studOrder[n] ?? 0] ?? 0;
  }
  return { ...page, chunkKeys: keys, chunkIndex };
}

export function groupRunEnd(runs: InstanceRuns, firstRun: number): number {
  let end = firstRun + 1;
  while (
    end < runs.shape.length &&
    runs.shape[end] === runs.shape[firstRun] &&
    runs.alphaSlot[end] === runs.alphaSlot[firstRun]
  ) {
    end++;
  }
  return end;
}

export function usesAnyShape(runs: InstanceRuns, shapes: ReadonlySet<number>): boolean {
  for (let run = 0; run < runs.shape.length; run++) {
    if (shapes.has(runs.shape[run] ?? 0)) return true;
  }
  return false;
}

export function matricesOf(page: InstancePage, start: number, end: number): Float32Array {
  return page.matrices.subarray(start * MATRIX4_FLOATS, end * MATRIX4_FLOATS);
}

export function linearColorsOf(page: InstancePage, start: number, end: number): Float32Array {
  return page.linearColors.subarray(start * COLOR_CHANNELS, end * COLOR_CHANNELS);
}
