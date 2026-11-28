import { decode } from "@brr/schema/decode";
import { MAX_REQUEST_JSON_BYTES } from "@brr/schema/layout-api";
import { parseJsonText } from "@brr/schema/world";
import type * as v from "valibot";
import { issuesProblem, problem } from "./http.ts";
import { strictUtf8Text } from "./utf8.ts";

export type BodyRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response };

const DECIMAL = /^[0-9]+$/u;

export async function readBytes(
  request: Request,
  maxBytes: number,
): Promise<BodyRead<Uint8Array<ArrayBuffer>>> {
  const declared = request.headers.get("content-length");
  if (declared === null || !DECIMAL.test(declared)) {
    return { ok: false, response: problem(411, "send the body with a Content-Length header") };
  }
  if (Number(declared) > maxBytes) {
    return {
      ok: false,
      response: problem(413, `the body is ${declared} bytes; the limit is ${maxBytes}`),
    };
  }
  return { ok: true, value: new Uint8Array(await request.arrayBuffer()) };
}

export async function readJson<const TSchema extends v.GenericSchema>(
  request: Request,
  schema: TSchema,
): Promise<BodyRead<v.InferOutput<TSchema>>> {
  const bytes = await readBytes(request, MAX_REQUEST_JSON_BYTES);
  if (!bytes.ok) return bytes;
  const text = strictUtf8Text(bytes.value, "body");
  if (!text.ok) return { ok: false, response: issuesProblem(400, text.issues) };
  const json = parseJsonText(text.value, "body");
  const decoded = json.ok ? decode(schema, json.value, "body") : json;
  if (!decoded.ok) return { ok: false, response: issuesProblem(400, decoded.issues) };
  return { ok: true, value: decoded.value };
}
