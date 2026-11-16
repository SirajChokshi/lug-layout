const INITIAL_QUADS = 4096;
const VERTICES_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;
const FLOATS_PER_VERTEX = 3;
const UINT16_VERTEX_LIMIT = 65_536;

export interface VoxelMeshArrays {
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly positions: Float32Array;
  readonly colorIndex: Uint16Array;
  readonly indices: Uint16Array | Uint32Array;
}

export class QuadMeshBuilder {
  private quadCapacity = INITIAL_QUADS;
  private positions = new Float32Array(INITIAL_QUADS * VERTICES_PER_QUAD * FLOATS_PER_VERTEX);
  private colorIndex = new Uint16Array(INITIAL_QUADS * VERTICES_PER_QUAD);
  quads = 0;

  reset(): void {
    this.quads = 0;
  }

  private grow(): void {
    this.quadCapacity *= 2;
    const positions = new Float32Array(this.quadCapacity * VERTICES_PER_QUAD * FLOATS_PER_VERTEX);
    positions.set(this.positions);
    this.positions = positions;
    const colorIndex = new Uint16Array(this.quadCapacity * VERTICES_PER_QUAD);
    colorIndex.set(this.colorIndex);
    this.colorIndex = colorIndex;
  }

  addQuad(
    corner: Float64Array,
    edgeU: Float64Array,
    edgeV: Float64Array,
    normalSign: number,
    color: number,
  ): void {
    if (this.quads === this.quadCapacity) this.grow();
    const firstVertex = this.quads * VERTICES_PER_QUAD;
    for (let k = 0; k < VERTICES_PER_QUAD; k++) {
      const corner01 = normalSign > 0 ? k : (VERTICES_PER_QUAD - k) % VERTICES_PER_QUAD;
      const alongU = corner01 === 1 || corner01 === 2 ? 1 : 0;
      const alongV = corner01 === 2 || corner01 === 3 ? 1 : 0;
      const o = (firstVertex + k) * FLOATS_PER_VERTEX;
      for (let axis = 0; axis < FLOATS_PER_VERTEX; axis++) {
        this.positions[o + axis] =
          (corner[axis] ?? 0) + alongU * (edgeU[axis] ?? 0) + alongV * (edgeV[axis] ?? 0);
      }
      this.colorIndex[firstVertex + k] = color;
    }
    this.quads++;
  }

  finish(): VoxelMeshArrays {
    const vertexCount = this.quads * VERTICES_PER_QUAD;
    const indexCount = this.quads * INDICES_PER_QUAD;
    const indices =
      vertexCount <= UINT16_VERTEX_LIMIT
        ? new Uint16Array(indexCount)
        : new Uint32Array(indexCount);
    for (let q = 0; q < this.quads; q++) {
      const v = q * VERTICES_PER_QUAD;
      const i = q * INDICES_PER_QUAD;
      indices[i] = v;
      indices[i + 1] = v + 1;
      indices[i + 2] = v + 2;
      indices[i + 3] = v;
      indices[i + 4] = v + 2;
      indices[i + 5] = v + 3;
    }
    return {
      vertexCount,
      indexCount,
      positions: this.positions.slice(0, vertexCount * FLOATS_PER_VERTEX),
      colorIndex: this.colorIndex.slice(0, vertexCount),
      indices,
    };
  }
}
