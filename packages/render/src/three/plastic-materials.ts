import {
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  type MeshPhysicalNodeMaterialParameters,
  type MeshStandardNodeMaterialParameters,
  type Node,
  type NodeBuilder,
  type TextureNode,
} from "three/webgpu";
import {
  attribute,
  instanceColor,
  int,
  ivec2,
  mat4,
  materialColor,
  normalLocal,
  positionLocal,
  transformNormal,
  uint,
  vec4,
} from "three/tsl";
import { STUD_BASIS_INDEX_MASK, STUD_COLOR_INDEX_SHIFT } from "./instance-page.ts";
import { STUD_BASIS_TEXELS } from "./stud-basis-table.ts";

const M0_ROUGHNESS = 0.3;
const PLASTIC_ROUGHNESS = 0.25;
const PLASTIC_CLEARCOAT = 1;
const PLASTIC_CLEARCOAT_ROUGHNESS = 0.08;
const BASE_LAYER_SPECULAR = 0;
export const OPAQUE_ALPHA = 255;
export const LOOKUP_TEXELS_PER_ROW = 1536;

export interface StudLookups {
  readonly studBasisTexture: TextureNode;
  readonly linearColorTexture: TextureNode;
}

function lookupTexel(index: Node<"uint">): Node {
  return ivec2(
    int(index.mod(uint(LOOKUP_TEXELS_PER_ROW))),
    int(index.div(uint(LOOKUP_TEXELS_PER_ROW))),
  );
}

function applyStudBasis(lookups: StudLookups): void {
  const basisAndColorIndex = attribute("studBasisAndColorIndex", "uint");
  const firstTexel = basisAndColorIndex
    .bitAnd(uint(STUD_BASIS_INDEX_MASK))
    .mul(uint(STUD_BASIS_TEXELS));
  const bases = lookups.studBasisTexture;
  const matrix = mat4(
    bases.load(lookupTexel(firstTexel)),
    bases.load(lookupTexel(firstTexel.add(uint(1)))),
    bases.load(lookupTexel(firstTexel.add(uint(2)))),
    vec4(attribute("studTranslations", "vec3"), 1),
  );
  positionLocal.assign(matrix.mul(positionLocal).xyz);
  normalLocal.assign(transformNormal(normalLocal, matrix));
  const colorIndex = basisAndColorIndex.shiftRight(uint(STUD_COLOR_INDEX_SHIFT));
  instanceColor.assign(lookups.linearColorTexture.load(lookupTexel(colorIndex)).rgb);
}

class BasisInstancedStandardMaterial extends MeshStandardNodeMaterial {
  constructor(
    parameters: MeshStandardNodeMaterialParameters,
    private readonly lookups: StudLookups,
  ) {
    super(parameters);
    this.colorNode = materialColor.mul(instanceColor);
  }

  override setupPosition(builder: NodeBuilder): Node {
    const position = super.setupPosition(builder);
    applyStudBasis(this.lookups);
    return position;
  }
}

class BasisInstancedPhysicalMaterial extends MeshPhysicalNodeMaterial {
  constructor(
    parameters: MeshPhysicalNodeMaterialParameters,
    private readonly lookups: StudLookups,
  ) {
    super(parameters);
    this.colorNode = materialColor.mul(instanceColor);
  }

  override setupPosition(builder: NodeBuilder): Node {
    const position = super.setupPosition(builder);
    applyStudBasis(this.lookups);
    return position;
  }
}

function sharedParameters(vertexColors: boolean, opacity: number) {
  const transparent = opacity < 1;
  return {
    metalness: 0,
    vertexColors,
    transparent,
    opacity,
    depthWrite: !transparent,
  };
}

const PLASTIC_PARAMETERS = {
  roughness: PLASTIC_ROUGHNESS,
  clearcoat: PLASTIC_CLEARCOAT,
  clearcoatRoughness: PLASTIC_CLEARCOAT_ROUGHNESS,
  specularIntensity: BASE_LAYER_SPECULAR,
};

function plasticMaterial(plastic: boolean, vertexColors: boolean, opacity: number) {
  const shared = sharedParameters(vertexColors, opacity);
  return plastic
    ? new MeshPhysicalNodeMaterial({ ...shared, ...PLASTIC_PARAMETERS })
    : new MeshStandardNodeMaterial({ ...shared, roughness: M0_ROUGHNESS });
}

function basisInstancedMaterial(plastic: boolean, opacity: number, lookups: StudLookups) {
  const shared = sharedParameters(false, opacity);
  return plastic
    ? new BasisInstancedPhysicalMaterial({ ...shared, ...PLASTIC_PARAMETERS }, lookups)
    : new BasisInstancedStandardMaterial({ ...shared, roughness: M0_ROUGHNESS }, lookups);
}

export class PlasticMaterials {
  private readonly instanced = new Map<number, MeshStandardNodeMaterial>();
  private readonly fixed = new Map<number, MeshStandardNodeMaterial>();
  private readonly basis = new Map<number, MeshStandardNodeMaterial>();

  constructor(
    private readonly plastic: boolean,
    private readonly opacityScale: number,
    private readonly lookups: StudLookups,
  ) {}

  instanceColored(alpha: number): MeshStandardNodeMaterial {
    return this.cached(this.instanced, alpha, () =>
      plasticMaterial(this.plastic, false, this.opacityOf(alpha)),
    );
  }

  vertexColored(alpha: number): MeshStandardNodeMaterial {
    return this.cached(this.fixed, alpha, () =>
      plasticMaterial(this.plastic, true, this.opacityOf(alpha)),
    );
  }

  basisInstanced(alpha: number): MeshStandardNodeMaterial {
    return this.cached(this.basis, alpha, () =>
      basisInstancedMaterial(this.plastic, this.opacityOf(alpha), this.lookups),
    );
  }

  private opacityOf(alpha: number): number {
    return (alpha / OPAQUE_ALPHA) * this.opacityScale;
  }

  private cached(
    cache: Map<number, MeshStandardNodeMaterial>,
    alpha: number,
    create: () => MeshStandardNodeMaterial,
  ): MeshStandardNodeMaterial {
    let material = cache.get(alpha);
    if (!material) {
      material = create();
      cache.set(alpha, material);
    }
    return material;
  }
}
