import { COLOR_CHANNELS, INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "../scene-backend.ts";

export const MATRIX4_FLOATS = 16;

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

interface InstanceSource {
  readonly count: number;
  readonly matrices: Float32Array;
  readonly shape: ArrayLike<number>;
  readonly colorIndex: ArrayLike<number>;
  readonly voxelized: ArrayLike<number> | null;
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
): InstancePage {
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
  return page;
}

function matrix4Of(source: Float32Array, count: number): Float32Array {
  const matrices = new Float32Array(count * MATRIX4_FLOATS);
  for (let i = 0; i < count; i++) writeMatrix4(source, i, matrices, i);
  return matrices;
}

export function pageOf(
  instances: ChunkInstances,
  linearColors: Float32Array,
  colorAlphaSlot: Uint8Array,
): InstancePage {
  const { studs } = instances;
  return build(
    instances.originX,
    instances.originZ,
    {
      count: instances.count,
      matrices: matrix4Of(instances.matrices, instances.count),
      shape: instances.partIndex,
      colorIndex: instances.colorIndex,
      voxelized: instances.voxelized ?? new Uint8Array(instances.count),
    },
    {
      count: studs.count,
      matrices: matrix4Of(studs.matrices, studs.count),
      shape: studs.primitiveIndex,
      colorIndex: studs.colorIndex,
      voxelized: null,
    },
    linearColors,
    colorAlphaSlot,
  );
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
  );
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
