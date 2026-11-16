export interface GpuMemorySnapshot {
  readonly bufferBytes: number;
  readonly textureBytes: number;
  readonly liveBuffers: number;
  readonly liveTextures: number;
}

const WEBGPU_BYTES_PER_TEXEL: Readonly<Record<string, number>> = {
  r8unorm: 1,
  rg8unorm: 2,
  rgba8unorm: 4,
  "rgba8unorm-srgb": 4,
  bgra8unorm: 4,
  "bgra8unorm-srgb": 4,
  rgba16float: 8,
  rgba32float: 16,
  r32float: 4,
  depth16unorm: 2,
  depth24plus: 4,
  "depth24plus-stencil8": 4,
  depth32float: 4,
  "depth32float-stencil8": 8,
};

const WEBGL_BYTES_PER_TEXEL: Readonly<Record<number, number>> = {
  0x8058: 4,
  0x8c43: 4,
  0x881a: 8,
  0x8814: 16,
  0x822e: 4,
  0x81a5: 2,
  0x81a6: 4,
  0x8cac: 4,
  0x88f0: 4,
  0x8cad: 8,
  0x8229: 1,
  0x822b: 2,
};

const UNKNOWN_FORMAT_BYTES = 4;

class Tally {
  bufferBytes = 0;
  textureBytes = 0;
  liveBuffers = 0;
  liveTextures = 0;
  readonly bufferSizes = new WeakMap<object, number>();
  readonly textureSizes = new WeakMap<object, number>();

  addBuffer(handle: object, bytes: number): void {
    this.removeBuffer(handle);
    this.bufferSizes.set(handle, bytes);
    this.bufferBytes += bytes;
    this.liveBuffers++;
  }

  removeBuffer(handle: object): void {
    const bytes = this.bufferSizes.get(handle);
    if (bytes === undefined) return;
    this.bufferSizes.delete(handle);
    this.bufferBytes -= bytes;
    this.liveBuffers--;
  }

  addTexture(handle: object, bytes: number): void {
    this.removeTexture(handle);
    this.textureSizes.set(handle, bytes);
    this.textureBytes += bytes;
    this.liveTextures++;
  }

  removeTexture(handle: object): void {
    const bytes = this.textureSizes.get(handle);
    if (bytes === undefined) return;
    this.textureSizes.delete(handle);
    this.textureBytes -= bytes;
    this.liveTextures--;
  }
}

function mipChainTexels(width: number, height: number, layers: number, levels: number): number {
  let texels = 0;
  let w = width;
  let h = height;
  for (let level = 0; level < levels; level++) {
    texels += w * h * layers;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return texels;
}

function extentOf(size: GPUExtent3DStrict): [number, number, number] {
  if (Symbol.iterator in Object(size)) {
    const [w = 1, h = 1, d = 1] = Array.from(size as Iterable<number>);
    return [w, h, d];
  }
  const dict = size as GPUExtent3DDict;
  return [dict.width, dict.height ?? 1, dict.depthOrArrayLayers ?? 1];
}

function patchWebGpu(tally: Tally): void {
  if (typeof GPUDevice === "undefined") return;
  const createBuffer = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function patchedCreateBuffer(descriptor) {
    const buffer = createBuffer.call(this, descriptor);
    tally.addBuffer(buffer, descriptor.size);
    return buffer;
  };
  const destroyBuffer = GPUBuffer.prototype.destroy;
  GPUBuffer.prototype.destroy = function patchedDestroyBuffer() {
    tally.removeBuffer(this);
    destroyBuffer.call(this);
  };
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function patchedCreateTexture(descriptor) {
    const texture = createTexture.call(this, descriptor);
    const [w, h, layers] = extentOf(descriptor.size);
    const texels = mipChainTexels(w, h, layers, descriptor.mipLevelCount ?? 1);
    const bytesPerTexel = WEBGPU_BYTES_PER_TEXEL[descriptor.format] ?? UNKNOWN_FORMAT_BYTES;
    tally.addTexture(texture, texels * bytesPerTexel * (descriptor.sampleCount ?? 1));
    return texture;
  };
  const destroyTexture = GPUTexture.prototype.destroy;
  GPUTexture.prototype.destroy = function patchedDestroyTexture() {
    tally.removeTexture(this);
    destroyTexture.call(this);
  };
}

function patchWebGl2(tally: Tally): void {
  if (typeof WebGL2RenderingContext === "undefined") return;
  const proto = WebGL2RenderingContext.prototype;
  const bound = new WeakMap<WebGL2RenderingContext, Map<number, WebGLBuffer | null>>();
  const boundTextures = new WeakMap<WebGL2RenderingContext, Map<number, WebGLTexture | null>>();
  const boundRenderbuffers = new WeakMap<WebGL2RenderingContext, WebGLRenderbuffer | null>();

  const bindBuffer = proto.bindBuffer;
  proto.bindBuffer = function patchedBindBuffer(target, buffer) {
    let targets = bound.get(this);
    if (!targets) {
      targets = new Map();
      bound.set(this, targets);
    }
    targets.set(target, buffer);
    bindBuffer.call(this, target, buffer);
  };
  const bufferData = proto.bufferData as (this: WebGL2RenderingContext, ...args: unknown[]) => void;
  proto.bufferData = function patchedBufferData(this: WebGL2RenderingContext, ...args: unknown[]) {
    bufferData.apply(this, args);
    const [target, data] = args;
    const buffer = bound.get(this)?.get(target as number);
    if (!buffer) return;
    const bytes =
      typeof data === "number"
        ? data
        : ArrayBuffer.isView(data) || data instanceof ArrayBuffer
          ? data.byteLength
          : 0;
    tally.addBuffer(buffer, bytes);
  } as typeof proto.bufferData;
  const deleteBuffer = proto.deleteBuffer;
  proto.deleteBuffer = function patchedDeleteBuffer(buffer) {
    if (buffer) tally.removeBuffer(buffer);
    deleteBuffer.call(this, buffer);
  };

  const bindTexture = proto.bindTexture;
  proto.bindTexture = function patchedBindTexture(target, texture) {
    let targets = boundTextures.get(this);
    if (!targets) {
      targets = new Map();
      boundTextures.set(this, targets);
    }
    targets.set(target, texture);
    bindTexture.call(this, target, texture);
  };
  const texStorage2D = proto.texStorage2D;
  proto.texStorage2D = function patchedTexStorage2D(target, levels, format, width, height) {
    texStorage2D.call(this, target, levels, format, width, height);
    const texture = boundTextures.get(this)?.get(target);
    if (!texture) return;
    const bytesPerTexel = WEBGL_BYTES_PER_TEXEL[format] ?? UNKNOWN_FORMAT_BYTES;
    tally.addTexture(texture, mipChainTexels(width, height, 1, levels) * bytesPerTexel);
  };
  const deleteTexture = proto.deleteTexture;
  proto.deleteTexture = function patchedDeleteTexture(texture) {
    if (texture) tally.removeTexture(texture);
    deleteTexture.call(this, texture);
  };

  const bindRenderbuffer = proto.bindRenderbuffer;
  proto.bindRenderbuffer = function patchedBindRenderbuffer(target, renderbuffer) {
    boundRenderbuffers.set(this, renderbuffer);
    bindRenderbuffer.call(this, target, renderbuffer);
  };
  const renderbufferStorageMultisample = proto.renderbufferStorageMultisample;
  proto.renderbufferStorageMultisample = function patchedStorageMultisample(
    target,
    samples,
    format,
    width,
    height,
  ) {
    renderbufferStorageMultisample.call(this, target, samples, format, width, height);
    const renderbuffer = boundRenderbuffers.get(this);
    if (!renderbuffer) return;
    const bytesPerTexel = WEBGL_BYTES_PER_TEXEL[format] ?? UNKNOWN_FORMAT_BYTES;
    tally.addTexture(renderbuffer, width * height * bytesPerTexel * Math.max(samples, 1));
  };
  const renderbufferStorage = proto.renderbufferStorage;
  proto.renderbufferStorage = function patchedRenderbufferStorage(target, format, width, height) {
    renderbufferStorage.call(this, target, format, width, height);
    const renderbuffer = boundRenderbuffers.get(this);
    if (!renderbuffer) return;
    tally.addTexture(
      renderbuffer,
      width * height * (WEBGL_BYTES_PER_TEXEL[format] ?? UNKNOWN_FORMAT_BYTES),
    );
  };
}

export function installGpuMemoryProbe(): () => GpuMemorySnapshot {
  const tally = new Tally();
  patchWebGpu(tally);
  patchWebGl2(tally);
  return () => ({
    bufferBytes: tally.bufferBytes,
    textureBytes: tally.textureBytes,
    liveBuffers: tally.liveBuffers,
    liveTextures: tally.liveTextures,
  });
}
