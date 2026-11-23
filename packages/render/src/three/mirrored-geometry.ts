import { BufferAttribute, BufferGeometry } from "three/webgpu";

const TRIANGLE_CORNERS = 3;

function reversedWinding(index: BufferAttribute): BufferAttribute {
  const corners = index.array.slice();
  for (let t = 0; t + TRIANGLE_CORNERS <= corners.length; t += TRIANGLE_CORNERS) {
    const second = corners[t + 1] ?? 0;
    corners[t + 1] = corners[t + 2] ?? 0;
    corners[t + 2] = second;
  }
  return new BufferAttribute(corners, 1);
}

function twinOf(geometry: BufferGeometry): BufferGeometry {
  const index = geometry.getIndex();
  if (!index) throw new Error("only an indexed geometry has a mirrored twin");
  const twin = new BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    twin.setAttribute(name, attribute);
  }
  twin.setIndex(reversedWinding(index));
  twin.boundingBox = geometry.boundingBox?.clone() ?? null;
  twin.boundingSphere = geometry.boundingSphere?.clone() ?? null;
  return twin;
}

export class MirroredGeometries {
  private readonly twins = new WeakMap<BufferGeometry, BufferGeometry>();

  of(geometry: BufferGeometry): BufferGeometry {
    const known = this.twins.get(geometry);
    if (known) return known;
    const twin = twinOf(geometry);
    this.twins.set(geometry, twin);
    const disposeTwin = (): void => {
      geometry.removeEventListener("dispose", disposeTwin);
      this.twins.delete(geometry);
      twin.dispose();
    };
    geometry.addEventListener("dispose", disposeTwin);
    return twin;
  }
}
