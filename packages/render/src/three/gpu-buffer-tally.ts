import type { BufferMemory } from "../scene-backend.ts";

interface LiveBuffer {
  readonly bytes: number;
  readonly geometry: boolean;
}

function uploadedBytes(source: unknown, sourceOffset: unknown, length: unknown): number {
  if (typeof source === "number") return source;
  if (source instanceof ArrayBuffer) return source.byteLength;
  if (!ArrayBuffer.isView(source)) return 0;
  const elementBytes =
    "BYTES_PER_ELEMENT" in source && typeof source.BYTES_PER_ELEMENT === "number"
      ? source.BYTES_PER_ELEMENT
      : 1;
  if (typeof length === "number" && length > 0) return length * elementBytes;
  const offset = typeof sourceOffset === "number" ? sourceOffset : 0;
  return source.byteLength - offset * elementBytes;
}

export class GpuBufferTally {
  private readonly live = new Map<object, LiveBuffer>();
  private geometryBytes = 0;
  private otherBytes = 0;

  snapshot(): BufferMemory {
    return { vertexIndexBytes: this.geometryBytes, otherBytes: this.otherBytes };
  }

  private record(buffer: object, bytes: number, geometry: boolean): void {
    this.release(buffer);
    this.live.set(buffer, { bytes, geometry });
    if (geometry) this.geometryBytes += bytes;
    else this.otherBytes += bytes;
  }

  private release(buffer: object): void {
    const existing = this.live.get(buffer);
    if (!existing) return;
    this.live.delete(buffer);
    if (existing.geometry) this.geometryBytes -= existing.bytes;
    else this.otherBytes -= existing.bytes;
  }

  watchWebGpu(device: GPUDevice): void {
    const createBuffer = device.createBuffer.bind(device);
    device.createBuffer = (descriptor: GPUBufferDescriptor): GPUBuffer => {
      const buffer = createBuffer(descriptor);
      const geometry = (descriptor.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX)) !== 0;
      this.record(buffer, descriptor.size, geometry);
      const destroy = buffer.destroy.bind(buffer);
      buffer.destroy = (): undefined => {
        this.release(buffer);
        destroy();
        return undefined;
      };
      return buffer;
    };
  }

  watchWebGl2(gl: WebGL2RenderingContext): void {
    const bindings = new Map<number, number>([
      [gl.ARRAY_BUFFER, gl.ARRAY_BUFFER_BINDING],
      [gl.ELEMENT_ARRAY_BUFFER, gl.ELEMENT_ARRAY_BUFFER_BINDING],
      [gl.UNIFORM_BUFFER, gl.UNIFORM_BUFFER_BINDING],
      [gl.COPY_READ_BUFFER, gl.COPY_READ_BUFFER_BINDING],
      [gl.COPY_WRITE_BUFFER, gl.COPY_WRITE_BUFFER_BINDING],
      [gl.PIXEL_PACK_BUFFER, gl.PIXEL_PACK_BUFFER_BINDING],
      [gl.PIXEL_UNPACK_BUFFER, gl.PIXEL_UNPACK_BUFFER_BINDING],
      [gl.TRANSFORM_FEEDBACK_BUFFER, gl.TRANSFORM_FEEDBACK_BUFFER_BINDING],
    ]);
    const bufferData = gl.bufferData.bind(gl);
    const deleteBuffer = gl.deleteBuffer.bind(gl);
    gl.bufferData = (...args: unknown[]): void => {
      const [target, source, , sourceOffset, length] = args;
      const binding = typeof target === "number" ? bindings.get(target) : undefined;
      const bound: unknown = binding === undefined ? null : gl.getParameter(binding);
      Reflect.apply(bufferData, gl, args);
      if (bound instanceof WebGLBuffer) {
        const geometry = target === gl.ARRAY_BUFFER || target === gl.ELEMENT_ARRAY_BUFFER;
        this.record(bound, uploadedBytes(source, sourceOffset, length), geometry);
      }
    };
    gl.deleteBuffer = (buffer: WebGLBuffer | null): void => {
      if (buffer) this.release(buffer);
      deleteBuffer(buffer);
    };
  }
}
