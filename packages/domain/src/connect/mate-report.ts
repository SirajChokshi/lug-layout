import { IntKeyMap, MISSING } from "./int-key-map.ts";
import { NO_INSTANCE } from "./model-connectors.ts";

const INITIAL_CAPACITY = 256;
export const NO_PARTNER = -1;
export const NOT_ENGAGED = -1;
export const ENGAGED_AXIS = 0;
export const ENGAGED_U = 1;
export const ENGAGED_V = 2;
export const ENGAGED_FROM = 3;
export const ENGAGED_TO = 4;
export const ENGAGED_RADIUS = 5;
export const ENGAGEMENT_FLOATS = 6;
const JOINT_KEY_INTS = 6;

export class MateReport {
  private size = 0;
  private connectors: Int32Array;
  private sources: Uint8Array;
  private statuses: Uint8Array;
  private families: Uint8Array;
  private partners: Int32Array;
  private instances: Int32Array;
  private partnerInstances: Int32Array;
  private engagements: Float64Array;
  private joints: Int32Array;
  private jointTotal = 0;
  private readonly jointOfLine = new IntKeyMap(JOINT_KEY_INTS);
  private readonly jointKey = new Int32Array(JOINT_KEY_INTS);

  constructor(capacity: number = INITIAL_CAPACITY) {
    this.connectors = new Int32Array(capacity);
    this.sources = new Uint8Array(capacity);
    this.statuses = new Uint8Array(capacity);
    this.families = new Uint8Array(capacity);
    this.partners = new Int32Array(capacity);
    this.instances = new Int32Array(capacity);
    this.partnerInstances = new Int32Array(capacity);
    this.engagements = new Float64Array(capacity * ENGAGEMENT_FLOATS);
    this.joints = new Int32Array(capacity);
  }

  get count(): number {
    return this.size;
  }

  get connector(): Int32Array {
    return this.connectors;
  }

  get sourceMask(): Uint8Array {
    return this.sources;
  }

  get status(): Uint8Array {
    return this.statuses;
  }

  get family(): Uint8Array {
    return this.families;
  }

  get partner(): Int32Array {
    return this.partners;
  }

  get instance(): Int32Array {
    return this.instances;
  }

  get partnerInstance(): Int32Array {
    return this.partnerInstances;
  }

  get engagement(): Float64Array {
    return this.engagements;
  }

  get joint(): Int32Array {
    return this.joints;
  }

  get jointCount(): number {
    return this.jointTotal;
  }

  clear(): void {
    this.size = 0;
    this.jointTotal = 0;
    this.jointOfLine.clear();
  }

  push(
    connector: number,
    sourceMask: number,
    status: number,
    partner: number,
    instance: number,
    partnerInstance: number,
    engagement: Float64Array | null,
  ): void {
    if (this.size === this.connectors.length) this.grow();
    const k = this.size++;
    this.connectors[k] = connector;
    this.sources[k] = sourceMask;
    this.statuses[k] = status;
    this.partners[k] = partner;
    this.instances[k] = instance;
    this.partnerInstances[k] = partnerInstance;
    const at = k * ENGAGEMENT_FLOATS;
    if (engagement) {
      for (let f = 0; f < ENGAGEMENT_FLOATS; f++) this.engagements[at + f] = engagement[f] ?? 0;
    } else {
      this.engagements[at + ENGAGED_AXIS] = NOT_ENGAGED;
      this.engagements[at + ENGAGED_U] = 0;
      this.engagements[at + ENGAGED_V] = 0;
      this.engagements[at + ENGAGED_FROM] = 0;
      this.engagements[at + ENGAGED_TO] = 0;
      this.engagements[at + ENGAGED_RADIUS] = 0;
    }
    const identified =
      partner !== NO_PARTNER && instance !== NO_INSTANCE && partnerInstance !== NO_INSTANCE;
    this.joints[k] = identified && engagement ? this.lineJoint(k) : this.jointTotal++;
  }

  assignFamily(from: number, family: number): void {
    this.families.fill(family, from, this.size);
  }

  private lineJoint(k: number): number {
    const e = k * ENGAGEMENT_FLOATS;
    const key = this.jointKey;
    key[0] = this.partners[k] ?? NO_PARTNER;
    key[1] = this.instances[k] ?? NO_INSTANCE;
    key[2] = this.partnerInstances[k] ?? NO_INSTANCE;
    key[3] = this.engagements[e + ENGAGED_AXIS] ?? NOT_ENGAGED;
    key[4] = this.engagements[e + ENGAGED_U] ?? 0;
    key[5] = this.engagements[e + ENGAGED_V] ?? 0;
    const known = this.jointOfLine.get(key);
    if (known !== MISSING) return known;
    this.jointOfLine.set(key, this.jointTotal);
    return this.jointTotal++;
  }

  private grow(): void {
    const capacity = Math.max(1, this.connectors.length * 2);
    this.connectors = widened(this.connectors, new Int32Array(capacity));
    this.sources = widened(this.sources, new Uint8Array(capacity));
    this.statuses = widened(this.statuses, new Uint8Array(capacity));
    this.families = widened(this.families, new Uint8Array(capacity));
    this.partners = widened(this.partners, new Int32Array(capacity));
    this.instances = widened(this.instances, new Int32Array(capacity));
    this.partnerInstances = widened(this.partnerInstances, new Int32Array(capacity));
    this.engagements = widened(this.engagements, new Float64Array(capacity * ENGAGEMENT_FLOATS));
    this.joints = widened(this.joints, new Int32Array(capacity));
  }
}

function widened<T extends Int32Array | Uint8Array | Float64Array>(from: T, to: T): T {
  to.set(from);
  return to;
}
