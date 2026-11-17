import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface S3Request {
  readonly method: "GET" | "HEAD" | "PUT";
  readonly host: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadSha256: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const R2_REGION = "auto";
const SCOPE_TERMINATOR = "aws4_request";
const UNRESERVED_EXTRAS = /[!'()*]/gu;

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
}

export function encodeObjectPath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        UNRESERVED_EXTRAS,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

export function signS3Request(
  request: S3Request,
  credentials: S3Credentials,
  region: string,
  date: Date,
): Record<string, string> {
  const timestamp = amzDate(date);
  const day = timestamp.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value.trim()]),
    ),
    host: request.host,
    "x-amz-content-sha256": request.payloadSha256,
    "x-amz-date": timestamp,
  };
  const names = Object.keys(headers).toSorted();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method,
    request.path,
    "",
    ...names.map((name) => `${name}:${headers[name]}`),
    "",
    signedHeaders,
    request.payloadSha256,
  ].join("\n");
  const scope = `${day}/${region}/${SERVICE}/${SCOPE_TERMINATOR}`;
  const stringToSign = [ALGORITHM, timestamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = [day, region, SERVICE, SCOPE_TERMINATOR].reduce<Uint8Array | string>(
    (key, part) => hmac(key, part),
    `AWS4${credentials.secretAccessKey}`,
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface ObjectStore {
  has(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array, headers: Readonly<Record<string, string>>): Promise<void>;
}

export interface R2Bucket {
  readonly endpoint: string;
  readonly bucket: string;
  readonly credentials: S3Credentials;
}

export class R2ObjectStore implements ObjectStore {
  private readonly target: R2Bucket;

  constructor(target: R2Bucket) {
    this.target = target;
  }

  private async send(
    method: S3Request["method"],
    key: string,
    body: Uint8Array | undefined,
    headers: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const endpoint = new URL(this.target.endpoint);
    const path = `/${encodeObjectPath(this.target.bucket)}/${encodeObjectPath(key)}`;
    const signed = signS3Request(
      { method, host: endpoint.host, path, headers, payloadSha256: sha256Hex(body ?? "") },
      this.target.credentials,
      R2_REGION,
      new Date(),
    );
    const { host: _host, ...sent } = signed;
    return fetch(new URL(path, endpoint), {
      method,
      headers: sent,
      ...(body === undefined ? {} : { body }),
    });
  }

  async has(key: string): Promise<boolean> {
    const response = await this.send("HEAD", key, undefined, {});
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`HEAD ${key} failed with ${response.status}`);
    return true;
  }

  async put(
    key: string,
    body: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    const response = await this.send("PUT", key, body, headers);
    if (!response.ok) {
      throw new Error(`PUT ${key} failed with ${response.status}: ${await response.text()}`);
    }
  }
}
