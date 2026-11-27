import { CHUNK_STUDS, STUD_LDU } from "@brr/math";
import {
  Color,
  DataTexture,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Texture,
  Vector2,
  type Node,
  type Object3D,
} from "three/webgpu";
import {
  abs,
  cameraPosition,
  float,
  fract,
  fwidth,
  max,
  mix,
  normalWorld,
  positionWorld,
  saturate,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { GUIDE_GRID_STUDS, type GroundSettings, type GroundUnderlay } from "../scene-backend.ts";

const GROUND_COLOR = 0xbfbab0;
const UPWARD_NORMAL_Y = 0.5;
const GROUND_RENDER_ORDER = -1;
const LINE_SOFTNESS_PX = 0.5;
const VANISHED_SPACING_PX = 4;
const FULL_SPACING_PX = 18;
const LEAST_LDU_PER_PX = 1e-6;
const FOG_START_EYE_DISTANCES = 2.5;
const FOG_END_EYE_DISTANCES = 9;
const FOG_SHARE_OF_FAR_PLANE = 0.8;
const FOG_START_SHARE_OF_END = FOG_START_EYE_DISTANCES / FOG_END_EYE_DISTANCES;
const NO_FOG_FAR_PLANES = 4;
const ORTHOGRAPHIC_REACH_MARGIN = 1.25;
const UNDERLAY_MAX_TEXELS = 4096;

interface GridLevel {
  readonly stepLdu: number;
  readonly color: number;
  readonly opacity: number;
  readonly halfWidthPx: number;
}

const GRID_LEVELS: ReadonlyArray<GridLevel> = [
  { stepLdu: STUD_LDU, color: 0x857d71, opacity: 0.38, halfWidthPx: 0.5 },
  { stepLdu: GUIDE_GRID_STUDS * STUD_LDU, color: 0x655d51, opacity: 0.6, halfWidthPx: 0.6 },
  { stepLdu: CHUNK_STUDS * STUD_LDU, color: 0x463f35, opacity: 0.72, halfWidthPx: 0.85 },
];

interface UnderlayPicture {
  readonly image: Blob;
  readonly texture: Texture;
  readonly widthPx: number;
  readonly heightPx: number;
}

function linearRgb(srgb: number): Node<"vec3"> {
  const color = new Color(srgb);
  return vec3(color.r, color.g, color.b);
}

function lineCoverage(level: GridLevel, pxPerLdu: Node<"vec2">): Node<"float"> {
  const cell = positionWorld.xz.div(level.stepLdu);
  const spacingPx = pxPerLdu.mul(level.stepLdu);
  const offLinePx = abs(fract(cell.add(0.5)).sub(0.5)).mul(spacingPx);
  const onLine = saturate(vec2(level.halfWidthPx + LINE_SOFTNESS_PX).sub(offLinePx));
  const shown = smoothstep(VANISHED_SPACING_PX, FULL_SPACING_PX, spacingPx);
  const visible = onLine.mul(shown);
  return max(visible.x, visible.y);
}

function withUnderlaySampling<T extends Texture>(map: T): T {
  map.colorSpace = SRGBColorSpace;
  map.flipY = false;
  map.minFilter = LinearMipmapLinearFilter;
  map.magFilter = LinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return map;
}

async function decodedUnderlay(image: Blob): Promise<UnderlayPicture> {
  const full = await createImageBitmap(image);
  const widthPx = full.width;
  const heightPx = full.height;
  const shrink = Math.min(1, UNDERLAY_MAX_TEXELS / Math.max(widthPx, heightPx));
  let bitmap = full;
  if (shrink < 1) {
    bitmap = await createImageBitmap(full, {
      resizeWidth: Math.max(1, Math.round(widthPx * shrink)),
      resizeHeight: Math.max(1, Math.round(heightPx * shrink)),
      resizeQuality: "high",
    });
    full.close();
  }
  return { image, texture: withUnderlaySampling(new Texture(bitmap)), widthPx, heightPx };
}

export class GroundPlane {
  private readonly mesh: Mesh;
  private readonly gridShown = uniform(1);
  private readonly fogStart = uniform(0);
  private readonly fogEnd = uniform(1);
  private readonly underlayMap = texture(
    withUnderlaySampling(new DataTexture(new Uint8Array(4), 1, 1)),
  );
  private readonly underlayCorner = uniform(new Vector2());
  private readonly underlaySize = uniform(new Vector2(1, 1));
  private readonly underlayOpacity = uniform(0);
  private underlay: GroundUnderlay | null = null;
  private picture: UnderlayPicture | null = null;
  private decoding: Blob | null = null;
  private renderOriginX = 0;
  private renderOriginZ = 0;
  private topYLdu = 0;

  constructor(
    parent: Object3D,
    horizonColor: number,
    private readonly farPlaneLdu: number,
    private readonly redraw: () => void,
  ) {
    const geometry = new PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
      side: FrontSide,
      fog: false,
    });
    material.colorNode = mix(
      this.gridded(this.underlaid(GROUND_COLOR)),
      linearRgb(horizonColor),
      smoothstep(this.fogStart, this.fogEnd, positionWorld.distance(cameraPosition)),
    );
    this.mesh = new Mesh(geometry, material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = GROUND_RENDER_ORDER;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  private gridded(base: Node<"vec3">): Node<"vec3"> {
    const lduPerPx = max(fwidth(positionWorld.xz), vec2(LEAST_LDU_PER_PX, LEAST_LDU_PER_PX));
    const pxPerLdu = float(1).div(lduPerPx);
    let color = base;
    for (const level of GRID_LEVELS) {
      const alpha = lineCoverage(level, pxPerLdu).mul(level.opacity).mul(this.gridShown);
      color = mix(color, linearRgb(level.color), alpha);
    }
    return color;
  }

  griddedTop(baseSrgb: number): Node<"vec3"> {
    return mix(
      linearRgb(baseSrgb),
      this.gridded(linearRgb(baseSrgb)),
      step(UPWARD_NORMAL_Y, normalWorld.y),
    );
  }

  underlaid(baseSrgb: number): Node<"vec3"> {
    const at = positionWorld.xz.sub(this.underlayCorner).div(this.underlaySize);
    const inside = step(0, at.x).mul(step(at.x, 1)).mul(step(0, at.y)).mul(step(at.y, 1));
    const picture = this.underlayMap.sample(at);
    return mix(linearRgb(baseSrgb), picture.rgb, picture.a.mul(inside).mul(this.underlayOpacity));
  }

  configure(settings: GroundSettings | null): void {
    this.mesh.visible = settings !== null;
    if (!settings) return;
    this.topYLdu = settings.topYLdu;
    this.gridShown.value = settings.grid ? 1 : 0;
    this.underlay = settings.underlay;
    const image = settings.underlay?.image ?? null;
    if (image !== null && image !== this.picture?.image && image !== this.decoding) {
      this.decode(image);
    }
    this.placeUnderlay();
  }

  private decode(image: Blob): void {
    this.decoding = image;
    decodedUnderlay(image).then(
      (picture) => {
        if (this.decoding !== image) {
          picture.texture.dispose();
          return;
        }
        this.decoding = null;
        this.picture?.texture.dispose();
        this.picture = picture;
        this.underlayMap.value = picture.texture;
        this.placeUnderlay();
        this.redraw();
      },
      () => {
        if (this.decoding === image) this.decoding = null;
      },
    );
  }

  rebase(renderOriginX: number, renderOriginZ: number): void {
    this.renderOriginX = renderOriginX;
    this.renderOriginZ = renderOriginZ;
    this.placeUnderlay();
  }

  private placeUnderlay(): void {
    const { underlay, picture } = this;
    if (underlay === null || picture === null || picture.image !== underlay.image) {
      this.underlayOpacity.value = 0;
      return;
    }
    this.underlayCorner.value.set(
      underlay.cornerX - this.renderOriginX,
      underlay.cornerZ - this.renderOriginZ,
    );
    this.underlaySize.value.set(
      picture.widthPx * underlay.lduPerPixel,
      picture.heightPx * underlay.lduPerPixel,
    );
    this.underlayOpacity.value = underlay.opacity;
  }

  followPerspective(centreX: number, centreZ: number, eyeDistanceLdu: number): void {
    const fogEnd = Math.min(
      eyeDistanceLdu * FOG_END_EYE_DISTANCES,
      this.farPlaneLdu * FOG_SHARE_OF_FAR_PLANE,
    );
    this.fogStart.value = fogEnd * FOG_START_SHARE_OF_END;
    this.fogEnd.value = fogEnd;
    this.place(centreX, centreZ, fogEnd + eyeDistanceLdu);
  }

  followOrthographic(
    centreX: number,
    centreZ: number,
    halfWidthLdu: number,
    halfHeightLdu: number,
  ): void {
    this.fogStart.value = this.farPlaneLdu * NO_FOG_FAR_PLANES;
    this.fogEnd.value = this.farPlaneLdu * (NO_FOG_FAR_PLANES + 1);
    this.place(
      centreX,
      centreZ,
      Math.hypot(halfWidthLdu, halfHeightLdu) * ORTHOGRAPHIC_REACH_MARGIN,
    );
  }

  private place(centreX: number, centreZ: number, reachLdu: number): void {
    this.mesh.position.set(centreX, this.topYLdu, centreZ);
    this.mesh.scale.set(2 * reachLdu, 1, 2 * reachLdu);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
  }
}
