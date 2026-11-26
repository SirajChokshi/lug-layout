import type { LatticePose } from "@brr/domain";
import { placementBefore } from "../connect/placement-order.ts";

export interface RankedMember {
  readonly placeable: { readonly id: string };
}

const INITIAL_MEMBERS = 64;
const INSERTION_RUN = 16;
const NO_POSES: ReadonlyArray<LatticePose | undefined> = [];
const NO_MEMBERS: ReadonlyArray<RankedMember | undefined> = [];

export class MemberRanking {
  private order = new Int32Array(INITIAL_MEMBERS);
  private merged = new Int32Array(INITIAL_MEMBERS);
  private poses = NO_POSES;
  private members = NO_MEMBERS;

  rank(
    poses: ReadonlyArray<LatticePose | undefined>,
    members: ReadonlyArray<RankedMember | undefined>,
  ): Int32Array {
    const count = poses.length;
    this.reserve(count);
    this.poses = poses;
    this.members = members;
    for (let i = 0; i < count; i++) this.order[i] = i;
    for (let lo = 0; lo < count; lo += INSERTION_RUN) {
      this.insertionSort(lo, Math.min(lo + INSERTION_RUN, count));
    }
    for (let width = INSERTION_RUN; width < count; width *= 2) {
      for (let lo = 0; lo + width < count; lo += 2 * width) {
        this.merge(lo, lo + width, Math.min(lo + 2 * width, count));
      }
    }
    this.poses = NO_POSES;
    this.members = NO_MEMBERS;
    return this.order;
  }

  private insertionSort(lo: number, hi: number): void {
    const order = this.order;
    for (let i = lo + 1; i < hi; i++) {
      const index = order[i] ?? 0;
      let j = i - 1;
      for (; j >= lo && this.before(index, order[j] ?? 0); j--) order[j + 1] = order[j] ?? 0;
      order[j + 1] = index;
    }
  }

  private merge(lo: number, mid: number, hi: number): void {
    const order = this.order;
    const merged = this.merged;
    let left = lo;
    let right = mid;
    for (let at = lo; at < hi; at++) {
      const takeRight =
        left >= mid || (right < hi && this.before(order[right] ?? 0, order[left] ?? 0));
      merged[at] = takeRight ? (order[right++] ?? 0) : (order[left++] ?? 0);
    }
    for (let at = lo; at < hi; at++) order[at] = merged[at] ?? 0;
  }

  private before(index: number, other: number): boolean {
    const pose = this.poses[index];
    const member = this.members[index];
    if (!pose || !member) return false;
    const otherPose = this.poses[other];
    const otherMember = this.members[other];
    if (!otherPose || !otherMember) return true;
    return placementBefore(pose, member.placeable.id, otherPose, otherMember.placeable.id);
  }

  private reserve(count: number): void {
    if (count <= this.order.length) return;
    const capacity = Math.max(count, this.order.length * 2);
    this.order = new Int32Array(capacity);
    this.merged = new Int32Array(capacity);
  }
}
