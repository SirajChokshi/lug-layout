(() => {
  const live = new Map();
  const add = (key, kind, bytes) => live.set(key, { kind, bytes });
  if (typeof WebGL2RenderingContext !== "undefined") {
    const proto = WebGL2RenderingContext.prototype;
    const bound = new Map();
    const bind = proto.bindBuffer;
    proto.bindBuffer = function (target, buffer) {
      bound.set(target, buffer);
      return bind.call(this, target, buffer);
    };
    const data = proto.bufferData;
    proto.bufferData = function (target, src, usage, offset, length) {
      const args = arguments;
      const buffer = bound.get(target);
      let bytes = 0;
      if (typeof src === "number") bytes = src;
      else if (src) {
        const bpe = src.BYTES_PER_ELEMENT ?? 1;
        bytes = length !== undefined ? length * bpe : src.byteLength - (offset ?? 0) * bpe;
      }
      const kind =
        target === this.ARRAY_BUFFER ? "vertex" : target === this.ELEMENT_ARRAY_BUFFER ? "index" : target === this.UNIFORM_BUFFER ? "uniform" : "other";
      if (buffer) add(buffer, kind, bytes);
      return data.apply(this, args);
    };
    const del = proto.deleteBuffer;
    proto.deleteBuffer = function (buffer) {
      live.delete(buffer);
      return del.call(this, buffer);
    };
  }
  if (typeof GPUDevice !== "undefined") {
    const create = GPUDevice.prototype.createBuffer;
    GPUDevice.prototype.createBuffer = function (descriptor) {
      const buffer = create.call(this, descriptor);
      const u = descriptor.usage;
      const kind = u & 0x20 ? "vertex" : u & 0x10 ? "index" : u & 0x40 ? "uniform" : u & 0x80 ? "storage" : "other";
      add(buffer, kind, Number(descriptor.size));
      return buffer;
    };
    const destroy = GPUBuffer.prototype.destroy;
    GPUBuffer.prototype.destroy = function () {
      live.delete(this);
      return destroy.call(this);
    };
  }
  globalThis.__bufferTally = () => {
    const out = { count: live.size };
    for (const { kind, bytes } of live.values()) out[kind] = (out[kind] ?? 0) + bytes;
    return out;
  };
})();
