import { describe, expect, it } from "vitest";
import { encodeObjectPath, sha256Hex, signS3Request } from "./r2.ts";

const AWS_EXAMPLE_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const AWS_EXAMPLE_DATE = new Date("2013-05-24T00:00:00Z");
const AWS_EXAMPLE_HOST = "examplebucket.s3.amazonaws.com";

describe("signS3Request", () => {
  it.each([
    {
      name: "GET object with a range",
      method: "GET" as const,
      path: "/test.txt",
      headers: { Range: "bytes=0-9" },
      payload: "",
      signature: "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    },
    {
      name: "PUT object with an encoded key",
      method: "PUT" as const,
      path: `/${encodeObjectPath("test$file.text")}`,
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payload: "Welcome to Amazon S3.",
      signature: "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    },
  ])("matches the AWS SigV4 example: $name", ({ method, path, headers, payload, signature }) => {
    const signed = signS3Request(
      { method, host: AWS_EXAMPLE_HOST, path, headers, payloadSha256: sha256Hex(payload) },
      AWS_EXAMPLE_CREDENTIALS,
      "us-east-1",
      AWS_EXAMPLE_DATE,
    );
    expect(signed["authorization"]).toMatch(new RegExp(`Signature=${signature}$`, "u"));
  });
});
