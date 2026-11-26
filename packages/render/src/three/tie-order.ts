import { Group, type Object3D } from "three/webgpu";

export interface RenderSortKey {
  readonly groupOrder: number | null;
  readonly renderOrder: number | null;
  readonly z: number | null;
}

function signOfDifference(a: number | null, b: number | null): number {
  const difference = (a ?? 0) - (b ?? 0);
  return difference > 0 ? 1 : difference < 0 ? -1 : 0;
}

export function opaqueSort(a: RenderSortKey, b: RenderSortKey): number {
  if (a.groupOrder !== b.groupOrder) return signOfDifference(a.groupOrder, b.groupOrder);
  if (a.renderOrder !== b.renderOrder) return signOfDifference(a.renderOrder, b.renderOrder);
  return a.z === b.z ? 0 : signOfDifference(a.z, b.z);
}

export function transparentSort(a: RenderSortKey, b: RenderSortKey): number {
  if (a.groupOrder !== b.groupOrder) return signOfDifference(a.groupOrder, b.groupOrder);
  if (a.renderOrder !== b.renderOrder) return signOfDifference(a.renderOrder, b.renderOrder);
  return a.z === b.z ? 0 : signOfDifference(b.z, a.z);
}

export class KeyOrderedChildren {
  private readonly group = new Group();
  private readonly keys: number[] = [];

  constructor(parent: Object3D) {
    this.group.matrixAutoUpdate = false;
    parent.add(this.group);
  }

  add(child: Object3D, key: number): void {
    const index = this.firstIndexAtLeast(key);
    if (this.keys[index] === key || child.parent === this.group) {
      throw new Error("key or child already held");
    }
    this.group.add(child);
    const children = this.group.children;
    children.pop();
    children.splice(index, 0, child);
    this.keys.splice(index, 0, key);
  }

  remove(child: Object3D): void {
    const index = this.group.children.indexOf(child);
    if (index < 0) return;
    this.group.remove(child);
    this.keys.splice(index, 1);
  }

  clear(): void {
    this.group.clear();
    this.keys.length = 0;
  }

  private firstIndexAtLeast(key: number): number {
    let low = 0;
    let high = this.keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.keys[middle] ?? 0) < key) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}
