import { COLOR_CHANNELS, INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "../scene-backend.ts";
import type { StudBasisTable } from "./stud-basis-table.ts";

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
  readonly voxelized: Uint8Array;
  readonly shape: Uint16Array;
  readonly studTranslations: Float32Array;
  readonly studBasisAndColorIndex: Uint32Array;
  readonly partRuns: InstanceRuns;
  readonly studRuns: InstanceRuns;
}

export const TRANSLATION_FLOATS = 3;
export const STUD_BASIS_INDEX_MASK = 0xffff;
export const STUD_COLOR_INDEX_SHIFT = 16;

interface RunKeys {
  readonly count: number;
  readonly shape: ArrayLike<number>;
}

interface PartSource extends RunKeys {
  readonly matrices: Float32Array;
  readonly colorIndex: ArrayLike<number>;
  readonly voxelized: ArrayLike<number>;
}

interface StudSource extends RunKeys {
  readonly translations: Float32Array;
  readonly basisAndColorIndex: Uint32Array;
}

export function isNotUpright(instanceClass: number): boolean {
  return (instanceClass & CLASS_NOT_UPRIGHT) !== 0;
}

export function isVoxelized(instanceClass: number): boolean {
  return (instanceClass & CLASS_VOXELIZED) !== 0;
}

export function studBasisIndexOf(basisAndColorIndex: number): number {
  return basisAndColorIndex & STUD_BASIS_INDEX_MASK;
}

export function studColorIndexOf(basisAndColorIndex: number): number {
  return basisAndColorIndex >>> STUD_COLOR_INDEX_SHIFT;
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

function partClassesOf(parts: PartSource): Uint8Array {
  const classes = new Uint8Array(parts.count);
  for (let i = 0; i < parts.count; i++) {
    const voxelized = (parts.voxelized[i] ?? 0) !== 0 ? CLASS_VOXELIZED : 0;
    classes[i] = voxelized | (isUpright(parts.matrices, i) ? 0 : CLASS_NOT_UPRIGHT);
  }
  return classes;
}

function partSlotsOf(parts: PartSource, colorAlphaSlot: Uint8Array): Uint8Array {
  const slots = new Uint8Array(parts.count);
  for (let i = 0; i < parts.count; i++) slots[i] = colorAlphaSlot[parts.colorIndex[i] ?? 0] ?? 0;
  return slots;
}

function studSlotsOf(studs: StudSource, colorAlphaSlot: Uint8Array): Uint8Array {
  const slots = new Uint8Array(studs.count);
  for (let i = 0; i < studs.count; i++) {
    slots[i] = colorAlphaSlot[studColorIndexOf(studs.basisAndColorIndex[i] ?? 0)] ?? 0;
  }
  return slots;
}

function pageOrder(keys: RunKeys, slots: Uint8Array, classes: Uint8Array): Uint32Array {
  const order = new Uint32Array(keys.count);
  for (let i = 0; i < keys.count; i++) order[i] = i;
  const { shape } = keys;
  order.sort(
    (a, b) =>
      (shape[a] ?? 0) - (shape[b] ?? 0) ||
      (slots[a] ?? 0) - (slots[b] ?? 0) ||
      (classes[a] ?? 0) - (classes[b] ?? 0) ||
      a - b,
  );
  return orderGroupsByFirstIndex(order, keys, slots);
}

function sameGroup(keys: RunKeys, slots: Uint8Array, a: number, b: number): boolean {
  return keys.shape[a] === keys.shape[b] && slots[a] === slots[b];
}

function orderGroupsByFirstIndex(
  order: Uint32Array,
  keys: RunKeys,
  slots: Uint8Array,
): Uint32Array {
  let groupCount = 0;
  for (let n = 0; n < order.length; n++) {
    if (n === 0 || !sameGroup(keys, slots, order[n] ?? 0, order[n - 1] ?? 0)) groupCount++;
  }
  const groupStart = new Uint32Array(groupCount + 1);
  const firstIndex = new Uint32Array(groupCount);
  let group = -1;
  for (let n = 0; n < order.length; n++) {
    const i = order[n] ?? 0;
    if (n === 0 || !sameGroup(keys, slots, i, order[n - 1] ?? 0)) {
      group++;
      groupStart[group] = n;
      firstIndex[group] = i;
    } else if (i < (firstIndex[group] ?? 0)) {
      firstIndex[group] = i;
    }
  }
  groupStart[groupCount] = order.length;
  const groupsInFirstIndexOrder = new Uint32Array(groupCount);
  for (let g = 0; g < groupCount; g++) groupsInFirstIndexOrder[g] = g;
  groupsInFirstIndexOrder.sort((a, b) => (firstIndex[a] ?? 0) - (firstIndex[b] ?? 0));
  const ordered = new Uint32Array(order.length);
  let to = 0;
  for (const g of groupsInFirstIndexOrder) {
    for (let n = groupStart[g] ?? 0; n < (groupStart[g + 1] ?? 0); n++)
      ordered[to++] = order[n] ?? 0;
  }
  return ordered;
}

function sameRun(
  keys: RunKeys,
  slots: Uint8Array,
  classes: Uint8Array,
  a: number,
  b: number,
): boolean {
  return keys.shape[a] === keys.shape[b] && slots[a] === slots[b] && classes[a] === classes[b];
}

function runsOf(
  keys: RunKeys,
  order: Uint32Array,
  slots: Uint8Array,
  classes: Uint8Array,
  pageOffset: number,
): InstanceRuns {
  let count = 0;
  for (let n = 0; n < order.length; n++) {
    if (n === 0 || !sameRun(keys, slots, classes, order[n] ?? 0, order[n - 1] ?? 0)) count++;
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
    if (n === 0 || !sameRun(keys, slots, classes, i, order[n - 1] ?? 0)) {
      run++;
      runs.shape[run] = keys.shape[i] ?? 0;
      runs.alphaSlot[run] = slots[i] ?? 0;
      runs.instanceClass[run] = classes[i] ?? 0;
      runs.start[run] = pageOffset + n;
    }
    runs.end[run] = pageOffset + n + 1;
  }
  return runs;
}

function copyParts(
  parts: PartSource,
  order: Uint32Array,
  linearColors: Float32Array,
  page: InstancePage,
): void {
  for (let n = 0; n < order.length; n++) {
    const i = order[n] ?? 0;
    for (let f = 0; f < MATRIX4_FLOATS; f++) {
      page.matrices[n * MATRIX4_FLOATS + f] = parts.matrices[i * MATRIX4_FLOATS + f] ?? 0;
    }
    const color = parts.colorIndex[i] ?? 0;
    for (let channel = 0; channel < COLOR_CHANNELS; channel++) {
      page.linearColors[n * COLOR_CHANNELS + channel] =
        linearColors[color * COLOR_CHANNELS + channel] ?? 0;
    }
    page.colorIndex[n] = color;
    page.shape[n] = parts.shape[i] ?? 0;
    page.voxelized[n] = parts.voxelized[i] ?? 0;
  }
}

function copyStuds(studs: StudSource, order: Uint32Array, page: InstancePage): void {
  for (let n = 0; n < order.length; n++) {
    const i = order[n] ?? 0;
    for (let axis = 0; axis < TRANSLATION_FLOATS; axis++) {
      page.studTranslations[n * TRANSLATION_FLOATS + axis] =
        studs.translations[i * TRANSLATION_FLOATS + axis] ?? 0;
    }
    page.studBasisAndColorIndex[n] = studs.basisAndColorIndex[i] ?? 0;
    page.shape[page.partCount + n] = studs.shape[i] ?? 0;
  }
}

function build(
  originX: number,
  originZ: number,
  parts: PartSource,
  studs: StudSource,
  linearColors: Float32Array,
  colorAlphaSlot: Uint8Array,
): InstancePage {
  const partSlots = partSlotsOf(parts, colorAlphaSlot);
  const partClasses = partClassesOf(parts);
  const partOrder = pageOrder(parts, partSlots, partClasses);
  const studSlots = studSlotsOf(studs, colorAlphaSlot);
  const studClasses = new Uint8Array(studs.count);
  const studOrder = pageOrder(studs, studSlots, studClasses);
  const page: InstancePage = {
    originX,
    originZ,
    partCount: parts.count,
    instanceCount: parts.count + studs.count,
    matrices: new Float32Array(parts.count * MATRIX4_FLOATS),
    linearColors: new Float32Array(parts.count * COLOR_CHANNELS),
    colorIndex: new Uint16Array(parts.count),
    voxelized: new Uint8Array(parts.count),
    shape: new Uint16Array(parts.count + studs.count),
    studTranslations: new Float32Array(studs.count * TRANSLATION_FLOATS),
    studBasisAndColorIndex: new Uint32Array(studs.count),
    partRuns: runsOf(parts, partOrder, partSlots, partClasses, 0),
    studRuns: runsOf(studs, studOrder, studSlots, studClasses, parts.count),
  };
  copyParts(parts, partOrder, linearColors, page);
  copyStuds(studs, studOrder, page);
  return page;
}

function matrix4Of(source: Float32Array, count: number): Float32Array {
  const matrices = new Float32Array(count * MATRIX4_FLOATS);
  for (let i = 0; i < count; i++) writeMatrix4(source, i, matrices, i);
  return matrices;
}

function studSourceOf(instances: ChunkInstances, studBases: StudBasisTable): StudSource {
  const { studs } = instances;
  const translations = new Float32Array(studs.count * TRANSLATION_FLOATS);
  const basisAndColorIndex = new Uint32Array(studs.count);
  for (let i = 0; i < studs.count; i++) {
    const s = i * INSTANCE_MATRIX_FLOATS;
    translations[i * TRANSLATION_FLOATS] = studs.matrices[s + 3] ?? 0;
    translations[i * TRANSLATION_FLOATS + 1] = studs.matrices[s + 7] ?? 0;
    translations[i * TRANSLATION_FLOATS + 2] = studs.matrices[s + 11] ?? 0;
    const color = studs.colorIndex[i] ?? 0;
    basisAndColorIndex[i] =
      ((color << STUD_COLOR_INDEX_SHIFT) | studBases.indexOf(studs.matrices, i)) >>> 0;
  }
  return { count: studs.count, shape: studs.primitiveIndex, translations, basisAndColorIndex };
}

export function pageOf(
  instances: ChunkInstances,
  linearColors: Float32Array,
  colorAlphaSlot: Uint8Array,
  studBases: StudBasisTable,
): InstancePage {
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
    studSourceOf(instances, studBases),
    linearColors,
    colorAlphaSlot,
  );
}

const ALPHA_SLOT_LIMIT = 256;
const UNMAPPED_SLOT = -1;

function colorIndexAt(page: InstancePage, instance: number): number {
  return instance < page.partCount
    ? (page.colorIndex[instance] ?? 0)
    : studColorIndexOf(page.studBasisAndColorIndex[instance - page.partCount] ?? 0);
}

function mapsSlotsOneToOne(
  page: InstancePage,
  runs: InstanceRuns,
  colorAlphaSlot: Uint8Array,
  newSlotOf: Int16Array,
  oldSlotOf: Int16Array,
): boolean {
  for (let run = 0; run < runs.shape.length; run++) {
    const oldSlot = runs.alphaSlot[run] ?? 0;
    for (let i = runs.start[run] ?? 0; i < (runs.end[run] ?? 0); i++) {
      const newSlot = colorAlphaSlot[colorIndexAt(page, i)] ?? 0;
      const mapped = newSlotOf[oldSlot] ?? UNMAPPED_SLOT;
      if (mapped === UNMAPPED_SLOT) {
        if ((oldSlotOf[newSlot] ?? UNMAPPED_SLOT) !== UNMAPPED_SLOT) return false;
        newSlotOf[oldSlot] = newSlot;
        oldSlotOf[newSlot] = oldSlot;
      } else if (mapped !== newSlot) {
        return false;
      }
    }
  }
  return true;
}

export function preservesAlphaSlotSharing(page: InstancePage, colorAlphaSlot: Uint8Array): boolean {
  const newSlotOf = new Int16Array(ALPHA_SLOT_LIMIT).fill(UNMAPPED_SLOT);
  const oldSlotOf = new Int16Array(ALPHA_SLOT_LIMIT).fill(UNMAPPED_SLOT);
  return (
    mapsSlotsOneToOne(page, page.partRuns, colorAlphaSlot, newSlotOf, oldSlotOf) &&
    mapsSlotsOneToOne(page, page.studRuns, colorAlphaSlot, newSlotOf, oldSlotOf)
  );
}

export function regroupedPage(
  page: InstancePage,
  linearColors: Float32Array,
  colorAlphaSlot: Uint8Array,
): InstancePage {
  if (!preservesAlphaSlotSharing(page, colorAlphaSlot)) {
    throw new Error(
      "a page can only be regrouped when the same colours still share each alpha slot",
    );
  }
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
      shape: page.shape.subarray(parts),
      translations: page.studTranslations,
      basisAndColorIndex: page.studBasisAndColorIndex,
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

export function studTranslationsOf(page: InstancePage, start: number, end: number): Float32Array {
  return page.studTranslations.subarray(
    (start - page.partCount) * TRANSLATION_FLOATS,
    (end - page.partCount) * TRANSLATION_FLOATS,
  );
}

export function studBasisAndColorIndexOf(
  page: InstancePage,
  start: number,
  end: number,
): Uint32Array {
  return page.studBasisAndColorIndex.subarray(start - page.partCount, end - page.partCount);
}
