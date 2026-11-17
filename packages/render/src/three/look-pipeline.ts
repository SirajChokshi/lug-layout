import {
  HalfFloatType,
  Matrix4,
  RenderPipeline,
  RGFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
  type Node,
  type PassNode,
  type PerspectiveCamera,
  type Scene,
  type TextureNode,
  type WebGPURenderer,
} from "three/webgpu";
import {
  abs,
  unpackRGBToNormal,
  packNormalToRGB,
  dot,
  float,
  getViewPosition,
  instanceIndex,
  max,
  mix,
  mrt,
  normalize,
  normalView,
  output,
  pass,
  perspectiveDepthToViewZ,
  pow,
  renderOutput,
  sample,
  screenUV,
  select,
  smoothstep,
  uniform,
  vec2,
  vec4,
} from "three/tsl";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { oitPass } from "three/addons/tsl/display/OITPassNode.js";
import type { LookSettings } from "../scene-backend.ts";

const ID_MODULUS = 2048;
const STUD_PITCH_LDU = 20;
const AO_RADIUS_LDU = 28;
const AO_THICKNESS_LDU = 16;
const AO_STRENGTH = 0.85;
const SILHOUETTE_PLANE_GAP_RATIO = 0.004;
const SAME_SURFACE_PLANE_GAP_RATIO = 0.0015;
const CREASE_COS = 0.75;
const SILHOUETTE_INK = 0.6;
const SEAM_INK = 0.35;
const CREASE_INK = 0.3;
const OUTLINE_FADE_START_PX = 1.5;
const OUTLINE_FADE_END_PX = 7;
const CREASE_FADE_START_PX = 4;
const CREASE_FADE_END_PX = 12;
const BEVEL_RIM = 0.12;
const BEVEL_SPECULAR = 0.55;
const BEVEL_SHININESS = 24;

interface GBuffer {
  readonly depth: TextureNode;
  readonly normalAt: (uv: Node<"vec2">) => Node<"vec3">;
  readonly id: TextureNode;
}

const SINGLE_SAMPLE = { samples: 0 };

interface EdgeUniforms {
  readonly texel: Node<"vec2">;
  readonly near: Node<"float">;
  readonly far: Node<"float">;
  readonly focalPx: Node<"float">;
  readonly projectionInverse: Node<"mat4">;
  readonly sunView: Node<"vec3">;
}

interface Neighbour {
  readonly x: number;
  readonly y: number;
  readonly oneSided: boolean;
}

const NEIGHBOURS: ReadonlyArray<Neighbour> = [
  { x: 1, y: 0, oneSided: true },
  { x: 0, y: 1, oneSided: true },
  { x: -1, y: 0, oneSided: false },
  { x: 0, y: -1, oneSided: false },
];

function flag(condition: Node<"bool">): Node<"float"> {
  return select(condition, float(1), float(0));
}

export class LookPipeline {
  private readonly pipeline: RenderPipeline;
  private readonly texel = uniform(new Vector2(1, 1));
  private readonly near = uniform(1);
  private readonly far = uniform(2);
  private readonly focalPx = uniform(1);
  private readonly projectionInverse = uniform(new Matrix4());
  private readonly sunView = uniform(new Vector3(0, 1, 0));
  private readonly sunWorld = new Vector3();

  constructor(
    renderer: WebGPURenderer,
    scene: Scene,
    private readonly camera: PerspectiveCamera,
    look: LookSettings,
    sunDirection: Vector3,
    private readonly pixelRatio: number,
  ) {
    this.sunWorld.copy(sunDirection).normalize();
    const scenePass: PassNode = look.oit
      ? oitPass(scene, camera, SINGLE_SAMPLE)
      : pass(scene, camera, SINGLE_SAMPLE);
    let color: Node<"vec4"> = scenePass;
    const needsGBuffer = look.gtao || look.outlines || look.bevel;
    if (needsGBuffer) {
      const objectId = uniform(0).onObjectUpdate(({ object }) => (object?.id ?? 0) % ID_MODULUS);
      scenePass.setMRT(
        mrt({
          output,
          normal: vec4(packNormalToRGB(normalView), 1),
          id: vec4(objectId.add(1), instanceIndex.toFloat().mod(ID_MODULUS), 0, 1),
        }),
      );
      const normalTexture = scenePass.getTexture("normal");
      normalTexture.type = UnsignedByteType;
      const idTexture = scenePass.getTexture("id");
      idTexture.type = HalfFloatType;
      idTexture.format = RGFormat;
      const encodedNormal = scenePass.getTextureNode("normal");
      const gbuffer: GBuffer = {
        depth: scenePass.getTextureNode("depth"),
        normalAt: (uv) => normalize(unpackRGBToNormal(encodedNormal.sample(uv).xyz)),
        id: scenePass.getTextureNode("id"),
      };
      if (look.gtao) color = this.withAmbientOcclusion(color, gbuffer);
      if (look.outlines || look.bevel) color = this.withEdges(color, gbuffer, look);
    }
    this.pipeline = new RenderPipeline(renderer, fxaa(renderOutput(color)));
    this.pipeline.outputColorTransform = false;
  }

  private withAmbientOcclusion(color: Node<"vec4">, gbuffer: GBuffer): Node<"vec4"> {
    const aoNode = ao(
      gbuffer.depth,
      sample((uv) => gbuffer.normalAt(uv)),
      this.camera,
    );
    aoNode.radius.value = AO_RADIUS_LDU;
    aoNode.thickness.value = AO_THICKNESS_LDU;
    aoNode.resolutionScale = 1 / Math.max(this.pixelRatio, 1);
    const occlusion = aoNode.getTextureNode().sample(screenUV).r;
    return vec4(color.rgb.mul(mix(float(1), occlusion, AO_STRENGTH)), color.a);
  }

  private uniforms(): EdgeUniforms {
    return {
      texel: this.texel,
      near: this.near,
      far: this.far,
      focalPx: this.focalPx,
      projectionInverse: this.projectionInverse,
      sunView: this.sunView,
    };
  }

  private withEdges(color: Node<"vec4">, gbuffer: GBuffer, look: LookSettings): Node<"vec4"> {
    const u = this.uniforms();
    const viewDepth = (uv: Node<"vec2">): Node<"float"> =>
      perspectiveDepthToViewZ(gbuffer.depth.sample(uv).r, u.near, u.far).negate();
    const viewPosition = (uv: Node<"vec2">): Node<"vec3"> =>
      getViewPosition(uv, gbuffer.depth.sample(uv).r, u.projectionInverse);

    const uvC = screenUV;
    const rawDepthC = gbuffer.depth.sample(uvC).r;
    const zC = viewDepth(uvC);
    const nC = gbuffer.normalAt(uvC);
    const idC = gbuffer.id.sample(uvC).xy;
    const pC = viewPosition(uvC);
    const studPitchPx = u.focalPx.mul(STUD_PITCH_LDU).div(max(zC, float(1)));
    const outlineFade = smoothstep(OUTLINE_FADE_START_PX, OUTLINE_FADE_END_PX, studPitchPx);
    const creaseFade = smoothstep(CREASE_FADE_START_PX, CREASE_FADE_END_PX, studPitchPx);
    const viewDir = normalize(pC.negate());
    const halfVector = normalize(u.sunView.add(viewDir));

    let silhouette: Node<"float"> = float(0);
    let seam: Node<"float"> = float(0);
    let crease: Node<"float"> = float(0);
    let glint: Node<"float"> = float(0);
    for (const neighbour of NEIGHBOURS) {
      const uvN = uvC.add(vec2(neighbour.x, neighbour.y).mul(u.texel));
      const zN = viewDepth(uvN);
      const idN = gbuffer.id.sample(uvN).xy;
      const idDiffers = abs(idN.x.sub(idC.x))
        .add(abs(idN.y.sub(idC.y)))
        .greaterThan(0.5);
      const planeGap = dot(nC, viewPosition(uvN).sub(pC));
      const offPlane = abs(planeGap).greaterThan(zC.mul(SILHOUETTE_PLANE_GAP_RATIO));
      const neighbourBehind = zN.greaterThan(zC).and(offPlane);
      const sameSurface = abs(planeGap).lessThan(zC.mul(SAME_SURFACE_PLANE_GAP_RATIO));
      silhouette = max(silhouette, flag(neighbourBehind));
      if (!neighbour.oneSided) continue;
      const nN = gbuffer.normalAt(uvN);
      seam = max(seam, flag(idDiffers.and(sameSurface)));
      const bends = dot(nC, nN).lessThan(CREASE_COS).and(idDiffers.not());
      const convex = planeGap.lessThan(0);
      crease = max(crease, flag(bends.and(convex.not())));
      const bevelNormal = normalize(nC.add(nN));
      const highlight = pow(max(dot(bevelNormal, halfVector), float(0)), BEVEL_SHININESS)
        .mul(BEVEL_SPECULAR)
        .add(BEVEL_RIM);
      glint = max(glint, flag(bends.and(convex)).mul(highlight));
    }

    let rgb: Node<"vec3"> = color.rgb;
    if (look.outlines) {
      const ink = max(
        max(silhouette.mul(SILHOUETTE_INK), seam.mul(SEAM_INK)).mul(outlineFade),
        crease.mul(CREASE_INK).mul(creaseFade),
      );
      rgb = rgb.mul(float(1).sub(ink));
    }
    if (look.bevel) {
      rgb = rgb.add(float(1).sub(rgb).mul(glint.mul(creaseFade)));
    }
    const isBackground = rawDepthC.greaterThanEqual(1);
    return vec4(select(isBackground, color.rgb, rgb), color.a);
  }

  resize(bufferWidth: number, bufferHeight: number, focalLengthPx: number): void {
    this.texel.value.set(1 / Math.max(bufferWidth, 1), 1 / Math.max(bufferHeight, 1));
    this.focalPx.value = focalLengthPx;
  }

  render(): void {
    const camera = this.camera;
    this.near.value = camera.near;
    this.far.value = camera.far;
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
    this.sunView.value.copy(this.sunWorld).transformDirection(camera.matrixWorldInverse);
    this.pipeline.render();
  }

  dispose(): void {
    this.pipeline.dispose();
  }
}
