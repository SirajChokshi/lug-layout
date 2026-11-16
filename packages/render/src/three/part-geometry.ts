import { INHERIT_COLOR, type MeshArrays, type PartAsset } from "@brr/catalog";
import { BufferAttribute, BufferGeometry } from "three/webgpu";
import { COLOR_CHANNELS } from "../scene-backend.ts";

export type LinearColorLookup = (ldrawColor: number, out: Float32Array) => void;

function geometry(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  colors?: Float32Array,
): BufferGeometry {
  const result = new BufferGeometry();
  result.setAttribute("position", new BufferAttribute(positions, 3));
  result.setAttribute("normal", new BufferAttribute(normals, 3));
  if (colors) result.setAttribute("color", new BufferAttribute(colors, COLOR_CHANNELS));
  result.setIndex(new BufferAttribute(indices, 1));
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

export function primitiveGeometry(mesh: MeshArrays): BufferGeometry {
  return geometry(mesh.positions, mesh.normals, mesh.indices);
}

export function inheritBodyGeometry(part: PartAsset): BufferGeometry | undefined {
  const group = part.mesh.groups.find((g) => g.ldrawColor === INHERIT_COLOR);
  return group ? geometry(part.mesh.positions, part.mesh.normals, group.indices) : undefined;
}

class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  addIndexed(
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    color: Float32Array,
  ): void {
    const remap = new Map<number, number>();
    for (let i = 0; i < indices.length; i++) {
      const source = indices[i] ?? 0;
      let target = remap.get(source);
      if (target === undefined) {
        target = this.positions.length / 3;
        remap.set(source, target);
        this.positions.push(
          positions[source * 3] ?? 0,
          positions[source * 3 + 1] ?? 0,
          positions[source * 3 + 2] ?? 0,
        );
        this.normals.push(
          normals[source * 3] ?? 0,
          normals[source * 3 + 1] ?? 0,
          normals[source * 3 + 2] ?? 0,
        );
        this.colors.push(color[0] ?? 0, color[1] ?? 0, color[2] ?? 0);
      }
      this.indices.push(target);
    }
  }

  build(): BufferGeometry | undefined {
    if (this.indices.length === 0) return undefined;
    return geometry(
      Float32Array.from(this.positions),
      Float32Array.from(this.normals),
      Uint32Array.from(this.indices),
      Float32Array.from(this.colors),
    );
  }
}

export function fixedColorGeometry(
  part: PartAsset,
  linearColor: LinearColorLookup,
): BufferGeometry | undefined {
  const builder = new MeshBuilder();
  const color = new Float32Array(COLOR_CHANNELS);
  for (const group of part.mesh.groups) {
    if (group.ldrawColor === INHERIT_COLOR) continue;
    linearColor(group.ldrawColor, color);
    builder.addIndexed(part.mesh.positions, part.mesh.normals, group.indices, color);
  }
  return builder.build();
}
