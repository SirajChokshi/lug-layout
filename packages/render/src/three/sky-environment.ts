import {
  BackSide,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  type Texture,
  type WebGPURenderer,
} from "three/webgpu";
import { mix, positionLocal, smoothstep, uniform } from "three/tsl";

const ZENITH_COLOR = 0xffffff;
const HORIZON_COLOR = 0xe4ebf2;
const GROUND_COLOR = 0x5c574e;
const HORIZON_BLEND_START = -0.04;
const HORIZON_BLEND_END = 0.04;
const ZENITH_BLEND_END = 0.9;
const DOME_WIDTH_SEGMENTS = 64;
const DOME_HEIGHT_SEGMENTS = 32;
const BLUR_SIGMA = 0.04;

export function skyEnvironment(renderer: WebGPURenderer): Texture {
  const up = positionLocal.normalize().y;
  const sky = mix(
    uniform(new Color(HORIZON_COLOR)),
    uniform(new Color(ZENITH_COLOR)),
    smoothstep(0, ZENITH_BLEND_END, up),
  );
  const material = new MeshBasicNodeMaterial({ side: BackSide });
  material.colorNode = mix(
    uniform(new Color(GROUND_COLOR)),
    sky,
    smoothstep(HORIZON_BLEND_START, HORIZON_BLEND_END, up),
  );
  const geometry = new SphereGeometry(1, DOME_WIDTH_SEGMENTS, DOME_HEIGHT_SEGMENTS);
  const dome = new Scene();
  dome.add(new Mesh(geometry, material));
  const pmrem = new PMREMGenerator(renderer);
  const texture = pmrem.fromScene(dome, BLUR_SIGMA).texture;
  pmrem.dispose();
  geometry.dispose();
  material.dispose();
  return texture;
}
