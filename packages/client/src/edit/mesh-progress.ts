export interface MeshCounts {
  readonly wanted: number;
  readonly loaded: number;
  readonly failed: number;
  readonly absent: number;
}

export interface MeshProgress {
  readonly detailedPartMeshes: MeshCounts;
  readonly farPartMeshes: MeshCounts;
  readonly farModelMeshes: MeshCounts;
}

export const NO_MESHES: MeshCounts = { wanted: 0, loaded: 0, failed: 0, absent: 0 };

function countsSettled(counts: MeshCounts): boolean {
  return counts.loaded + counts.failed + counts.absent === counts.wanted;
}

export function meshesSettled(meshes: MeshProgress): boolean {
  return (
    countsSettled(meshes.detailedPartMeshes) &&
    countsSettled(meshes.farPartMeshes) &&
    countsSettled(meshes.farModelMeshes)
  );
}
