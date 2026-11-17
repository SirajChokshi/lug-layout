import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";

const M0_ROUGHNESS = 0.3;
const PLASTIC_ROUGHNESS = 0.25;
const PLASTIC_CLEARCOAT = 1;
const PLASTIC_CLEARCOAT_ROUGHNESS = 0.08;
const BASE_LAYER_SPECULAR = 0;
export const OPAQUE_ALPHA = 255;

function plasticMaterial(plastic: boolean, vertexColors: boolean, opacity: number) {
  const transparent = opacity < 1;
  const shared = {
    metalness: 0,
    vertexColors,
    transparent,
    opacity,
    depthWrite: !transparent,
  };
  return plastic
    ? new MeshPhysicalNodeMaterial({
        ...shared,
        roughness: PLASTIC_ROUGHNESS,
        clearcoat: PLASTIC_CLEARCOAT,
        clearcoatRoughness: PLASTIC_CLEARCOAT_ROUGHNESS,
        specularIntensity: BASE_LAYER_SPECULAR,
      })
    : new MeshStandardNodeMaterial({ ...shared, roughness: M0_ROUGHNESS });
}

export class PlasticMaterials {
  private readonly instanced = new Map<number, MeshStandardNodeMaterial>();
  private readonly fixed = new Map<number, MeshStandardNodeMaterial>();
  readonly all: MeshStandardNodeMaterial[] = [];
  readonly baseOpacities: number[] = [];

  constructor(
    private readonly plastic: boolean,
    private readonly opacityScale: number,
  ) {}

  instanceColored(alpha: number): MeshStandardNodeMaterial {
    return this.cached(this.instanced, alpha, false);
  }

  vertexColored(alpha: number): MeshStandardNodeMaterial {
    return this.cached(this.fixed, alpha, true);
  }

  private cached(
    cache: Map<number, MeshStandardNodeMaterial>,
    alpha: number,
    vertexColors: boolean,
  ): MeshStandardNodeMaterial {
    let material = cache.get(alpha);
    if (!material) {
      material = plasticMaterial(
        this.plastic,
        vertexColors,
        (alpha / OPAQUE_ALPHA) * this.opacityScale,
      );
      cache.set(alpha, material);
      this.all.push(material);
      this.baseOpacities.push(material.opacity);
    }
    return material;
  }
}
