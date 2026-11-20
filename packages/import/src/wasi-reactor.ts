const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const STDOUT = 1;
const STDERR = 2;
const IOVEC_BYTES = 8;
const MAX_RANDOM_BYTES_PER_CALL = 65_536;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const NANOSECONDS_PER_MILLISECOND_NUMBER = 1_000_000;
const CLOCK_MONOTONIC = 1;

class WasiExit {
  constructor(readonly code: number) {}
}

interface ReactorExports {
  readonly memory: WebAssembly.Memory;
  readonly request: (length: number) => number;
  readonly call: () => number;
  readonly response: () => number;
}

interface Instantiated {
  readonly exports: ReactorExports;
  readonly stderr: string[];
}

function isMemory(value: unknown): value is WebAssembly.Memory {
  return value instanceof WebAssembly.Memory;
}

function isFunction(value: unknown): value is (...args: number[]) => number {
  return typeof value === "function";
}

function instantiate(module: WebAssembly.Module): Instantiated {
  let memory: WebAssembly.Memory | undefined;
  const stderr: string[] = [];
  const decoder = new TextDecoder();
  const view = (): DataView => {
    if (!memory) throw new Error("WASI call before the module exported its memory");
    return new DataView(memory.buffer);
  };
  const wasi = {
    fd_write(fd: number, iovs: number, iovsLength: number, written: number): number {
      if ((fd !== STDOUT && fd !== STDERR) || !memory) return ERRNO_BADF;
      const data = view();
      let total = 0;
      for (let i = 0; i < iovsLength; i++) {
        const base = iovs + i * IOVEC_BYTES;
        const pointer = data.getUint32(base, true);
        const length = data.getUint32(base + 4, true);
        if (fd === STDERR)
          stderr.push(decoder.decode(new Uint8Array(memory.buffer, pointer, length)));
        total += length;
      }
      data.setUint32(written, total, true);
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
    clock_time_get(clock: number, _precision: bigint, time: number): number {
      const now =
        clock === CLOCK_MONOTONIC
          ? BigInt(Math.round(performance.now() * NANOSECONDS_PER_MILLISECOND_NUMBER))
          : BigInt(Math.round(Date.now())) * NANOSECONDS_PER_MILLISECOND;
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
  const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi });
  const { memory: exported, _initialize, brr_request, brr_call, brr_response } = instance.exports;
  if (
    !isMemory(exported) ||
    !isFunction(_initialize) ||
    !isFunction(brr_request) ||
    !isFunction(brr_call) ||
    !isFunction(brr_response)
  ) {
    throw new Error("module is not the brick-compile reactor (missing memory or brr_* exports)");
  }
  memory = exported;
  _initialize();
  return {
    stderr,
    exports: { memory: exported, request: brr_request, call: brr_call, response: brr_response },
  };
}

export class WasiReactor {
  private live: Instantiated;
  private instances = 1;

  constructor(private readonly module: WebAssembly.Module) {
    this.live = instantiate(module);
  }

  get generation(): number {
    return this.instances;
  }

  call(request: Uint8Array): Uint8Array {
    const { exports, stderr } = this.live;
    stderr.length = 0;
    try {
      const at = exports.request(request.length) >>> 0;
      new Uint8Array(exports.memory.buffer, at, request.length).set(request);
      const length = exports.call() >>> 0;
      const from = exports.response() >>> 0;
      return new Uint8Array(exports.memory.buffer, from, length).slice();
    } catch (error) {
      this.live = instantiate(this.module);
      this.instances++;
      const panic = stderr.join("").trim();
      throw new Error(panic === "" ? String(error) : `${String(error)}: ${panic}`, {
        cause: error,
      });
    }
  }
}
