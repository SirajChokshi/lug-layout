import {
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  Sphere,
  type BufferGeometry,
  type InstancedBufferAttribute,
  type Material,
  type Object3D,
} from "three/webgpu";
import { TRANSLATION_FLOATS, studBasisIndexOf } from "./instance-page.ts";
import { STUD_BASIS_FLOATS, type StudBasisTable } from "./stud-basis-table.ts";

const studMatrix = new Matrix4();
const studSphere = new Sphere();

export class StudMesh extends Mesh<InstancedBufferGeometry, Material> {
  readonly boundingSphere = new Sphere();

  constructor(
    primitive: BufferGeometry,
    material: Material,
    readonly studTranslations: InstancedBufferAttribute,
    readonly studBasisAndColorIndex: InstancedBufferAttribute,
    private readonly studBases: StudBasisTable,
  ) {
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(primitive.index);
    geometry.setAttribute("position", primitive.getAttribute("position"));
    geometry.setAttribute("normal", primitive.getAttribute("normal"));
    geometry.setAttribute("studTranslations", studTranslations);
    geometry.setAttribute("studBasisAndColorIndex", studBasisAndColorIndex);
    geometry.boundingSphere = primitive.boundingSphere?.clone() ?? null;
    geometry.instanceCount = studBasisAndColorIndex.count;
    super(geometry, material);
  }

  computeBoundingSphere(): void {
    const geometry = this.geometry;
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    const local = geometry.boundingSphere;
    this.boundingSphere.makeEmpty();
    if (!local) return;
    const translations = this.studTranslations.array;
    const basisAndColorIndex = this.studBasisAndColorIndex.array;
    const columns = this.studBases.columns;
    const e = studMatrix.elements;
    for (let i = 0; i < geometry.instanceCount; i++) {
      const c = studBasisIndexOf(basisAndColorIndex[i] ?? 0) * STUD_BASIS_FLOATS;
      const t = i * TRANSLATION_FLOATS;
      for (let f = 0; f < STUD_BASIS_FLOATS; f++) e[f] = columns[c + f] ?? 0;
      e[12] = translations[t] ?? 0;
      e[13] = translations[t + 1] ?? 0;
      e[14] = translations[t + 2] ?? 0;
      e[15] = 1;
      studSphere.copy(local).applyMatrix4(studMatrix);
      this.boundingSphere.union(studSphere);
    }
  }

  override dispose(): void {
    super.dispose();
    this.studTranslations.dispose();
    this.studBasisAndColorIndex.dispose();
  }
}

export function isInstanced(object: Object3D): object is InstancedMesh | StudMesh {
  return object instanceof InstancedMesh || object instanceof StudMesh;
}
