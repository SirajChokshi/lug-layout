export interface RpcMessageEvent {
  readonly data: unknown;
}

export interface RpcPort {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: RpcMessageEvent) => void): void;
}

export interface RpcProtocol {
  readonly name: string;
  readonly version: number;
}

export interface RpcEnvelope<Body> {
  readonly protocol: string;
  readonly version: number;
  readonly id: number;
  readonly replyTo: number;
  readonly body: Body;
}

export const NO_REPLY = 0;

interface Pending<Receive> {
  readonly resolve: (body: Receive) => void;
}

function isEnvelope(value: unknown): value is RpcEnvelope<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "protocol" in value &&
    "version" in value &&
    "id" in value &&
    "replyTo" in value &&
    "body" in value
  );
}

export class RpcEndpoint<Send, Receive> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending<Receive>>();
  private handler: ((body: Receive, id: number) => void) | undefined;

  constructor(
    private readonly port: RpcPort,
    private readonly protocol: RpcProtocol,
  ) {
    port.addEventListener("message", (event) => this.receive(event.data));
  }

  listen(handler: (body: Receive, id: number) => void): void {
    this.handler = handler;
  }

  post(body: Send, transfer: Transferable[] = []): void {
    this.send(NO_REPLY, body, transfer);
  }

  request(body: Send, transfer: Transferable[] = []): Promise<Receive> {
    const id = this.send(NO_REPLY, body, transfer);
    return new Promise((resolve) => this.pending.set(id, { resolve }));
  }

  reply(to: number, body: Send, transfer: Transferable[] = []): void {
    this.send(to, body, transfer);
  }

  private send(replyTo: number, body: Send, transfer: Transferable[]): number {
    const id = this.nextId++;
    const envelope: RpcEnvelope<Send> = {
      protocol: this.protocol.name,
      version: this.protocol.version,
      id,
      replyTo,
      body,
    };
    this.port.postMessage(envelope, transfer);
    return id;
  }

  private receive(data: unknown): void {
    if (!isEnvelope(data)) throw new Error(`${this.protocol.name}: message is not an rpc envelope`);
    if (data.protocol !== this.protocol.name || data.version !== this.protocol.version) {
      throw new Error(
        `${this.protocol.name} v${this.protocol.version} received ${String(data.protocol)} v${String(data.version)}`,
      );
    }
    const body = data.body as Receive;
    const pending = this.pending.get(data.replyTo);
    if (pending) {
      this.pending.delete(data.replyTo);
      pending.resolve(body);
      return;
    }
    this.handler?.(body, data.id);
  }
}
