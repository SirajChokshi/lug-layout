import type { LatticePose } from "@brr/domain";

export function placementBefore(
  pose: LatticePose,
  item: string,
  other: LatticePose,
  otherItem: string,
): boolean {
  if (pose.yPlates !== other.yPlates) return pose.yPlates < other.yPlates;
  if (pose.x !== other.x) return pose.x < other.x;
  if (pose.z !== other.z) return pose.z < other.z;
  if (pose.rot !== other.rot) return pose.rot < other.rot;
  return item < otherItem;
}
