const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const IOVEC_BYTES = 8;
const MAX_RANDOM_BYTES_PER_CALL = 65_536;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export interface WasiResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

class WasiExit {
  constructor(readonly code: number) {}
}

class ByteSink {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes.slice());
    this.length += bytes.length;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

function isMemory(value: unknown): value is WebAssembly.Memory {
  return value instanceof WebAssembly.Memory;
}

function isStart(value: unknown): value is () => void {
  return typeof value === "function";
}

export async function runWasiCommand(
  module: WebAssembly.Module,
  stdin: Uint8Array,
): Promise<WasiResult> {
  let memory: WebAssembly.Memory | undefined;
  let stdinOffset = 0;
  const stdout = new ByteSink();
  const stderr = new ByteSink();
  const view = (): DataView => {
    if (!memory) throw new Error("WASI call before the module exported its memory");
    return new DataView(memory.buffer);
  };
  const iovecs = (pointer: number, count: number): Array<readonly [number, number]> => {
    const data = view();
    return Array.from({ length: count }, (_, i) => {
      const base = pointer + i * IOVEC_BYTES;
      return [data.getUint32(base, true), data.getUint32(base + 4, true)] as const;
    });
  };
  const wasi = {
    fd_write(fd: number, iovs: number, iovsLength: number, written: number): number {
      const sink = fd === STDOUT ? stdout : fd === STDERR ? stderr : undefined;
      if (!sink || !memory) return ERRNO_BADF;
      let total = 0;
      for (const [pointer, length] of iovecs(iovs, iovsLength)) {
        sink.push(new Uint8Array(memory.buffer, pointer, length));
        total += length;
      }
      view().setUint32(written, total, true);
      return ERRNO_SUCCESS;
    },
    fd_read(fd: number, iovs: number, iovsLength: number, read: number): number {
      if (fd !== STDIN || !memory) return ERRNO_BADF;
      let total = 0;
      for (const [pointer, length] of iovecs(iovs, iovsLength)) {
        const chunk = stdin.subarray(stdinOffset, stdinOffset + length);
        new Uint8Array(memory.buffer, pointer, chunk.length).set(chunk);
        stdinOffset += chunk.length;
        total += chunk.length;
        if (chunk.length < length) break;
      }
      view().setUint32(read, total, true);
      return ERRNO_SUCCESS;
    },
    environ_sizes_get(count: number, size: number): number {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return ERRNO_SUCCESS;
    },
    environ_get(): number {
      return ERRNO_SUCCESS;
    },
    clock_time_get(_clock: number, _precision: bigint, time: number): number {
      const now = BigInt(Math.round(Date.now())) * NANOSECONDS_PER_MILLISECOND;
      view().setBigUint64(time, now, true);
      return ERRNO_SUCCESS;
    },
    random_get(pointer: number, length: number): number {
      if (!memory) return ERRNO_BADF;
      for (let offset = 0; offset < length; offset += MAX_RANDOM_BYTES_PER_CALL) {
        const size = Math.min(MAX_RANDOM_BYTES_PER_CALL, length - offset);
        crypto.getRandomValues(new Uint8Array(memory.buffer, pointer + offset, size));
      }
      return ERRNO_SUCCESS;
    },
    proc_exit(code: number): never {
      throw new WasiExit(code);
    },
  };
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exportedMemory = instance.exports["memory"];
  const start = instance.exports["_start"];
  if (!isMemory(exportedMemory) || !isStart(start)) {
    throw new Error("module is not a WASI command (no memory or _start export)");
  }
  memory = exportedMemory;
  let exitCode = 0;
  try {
    start();
  } catch (error) {
    if (!(error instanceof WasiExit)) {
      const panic = new TextDecoder().decode(stderr.bytes()).trim();
      throw new Error(panic === "" ? String(error) : `${String(error)}: ${panic}`, {
        cause: error,
      });
    }
    exitCode = error.code;
  }
  return { exitCode, stdout: stdout.bytes(), stderr: new TextDecoder().decode(stderr.bytes()) };
}
