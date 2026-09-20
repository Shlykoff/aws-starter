import { describe, expect, it, vi } from "vitest";
import { HttpPartnerClient, credentialsFromEnv } from "../../src/clients/http-partner-client";
import type { PartnerPayload } from "../../src/domain/partner-payload";

// No network: `fetch` is replaced by a fake, and the clock and the credentials are fixed,
// so the signature is the same on every run.
const URL_OF_PARTNER = "https://abc123.lambda-url.eu-north-1.on.aws/";
const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "fake-secret-access-key-for-tests",
  sessionToken: "fake-session-token",
};
const FIXED_NOW = new Date("2026-09-21T10:00:00.000Z");

const payload: PartnerPayload = {
  id: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
  partner: "Acme",
  subject: "Order 42",
  body: "Please ship.",
  createdAt: "2026-09-21T09:00:00.000Z",
};

type FetchFake = ReturnType<typeof vi.fn<typeof fetch>>;

function setup(respond: () => Promise<Response> | Response = () => new Response('{"accepted":true}', { status: 200 })) {
  const fetchFake: FetchFake = vi.fn<typeof fetch>(() => Promise.resolve(respond()));
  const client = new HttpPartnerClient({
    url: URL_OF_PARTNER,
    region: "eu-north-1",
    credentials: () => CREDENTIALS,
    fetch: fetchFake,
    now: () => FIXED_NOW,
  });
  return { client, fetchFake };
}

// The one call the client made, in a form that is easy to assert on.
function theRequest(fetchFake: FetchFake) {
  expect(fetchFake).toHaveBeenCalledTimes(1);
  const [url, init] = fetchFake.mock.calls[0] ?? [];
  return { url, init, headers: (init?.headers ?? {}) as Record<string, string> };
}

describe("HttpPartnerClient: the request", () => {
  it("POSTs the payload as JSON to the partner URL", async () => {
    const { client, fetchFake } = setup();

    await client.send(payload);

    const { url, init } = theRequest(fetchFake);
    expect(url).toBe(URL_OF_PARTNER);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string) as unknown).toEqual(payload);
  });

  it("sends Content-Type and the request id as Idempotency-Key", async () => {
    const { client, fetchFake } = setup();

    await client.send(payload);

    const { headers } = theRequest(fetchFake);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["idempotency-key"]).toBe("01J8Z3K5W0ABCDEFGHJKMNPQR1");
  });

  it("sets an 8 second timeout on the call", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { client, fetchFake } = setup();

    await client.send(payload);

    expect(timeout).toHaveBeenCalledWith(8000);
    expect(theRequest(fetchFake).init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not follow redirects", async () => {
    const { client, fetchFake } = setup();

    await client.send(payload);

    expect(theRequest(fetchFake).init?.redirect).toBe("error");
  });
});

describe("HttpPartnerClient: SigV4 signature", () => {
  it("signs for the service lambda in the given region, on the date of the clock", async () => {
    const { client, fetchFake } = setup();

    await client.send(payload);

    const { headers } = theRequest(fetchFake);
    expect(headers["x-amz-date"]).toBe("20260921T100000Z");
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260921\/eu-north-1\/lambda\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
  });

  it("signs the host, the content type, the idempotency key and the session token", async () => {
    const { client, fetchFake } = setup();

    await client.send(payload);

    const { headers } = theRequest(fetchFake);
    expect(headers["x-amz-security-token"]).toBe("fake-session-token");
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(headers.authorization ?? "")?.[1]?.split(";");
    expect(signedHeaders).toEqual(
      expect.arrayContaining(["host", "content-type", "idempotency-key", "x-amz-date", "x-amz-security-token"]),
    );
  });

  it("leaves the host header to fetch", async () => {
    const { client, fetchFake } = setup();

    await client.send(payload);

    expect(theRequest(fetchFake).headers).not.toHaveProperty("host");
  });

  it("gives the same signature for the same request and a different one for another body", async () => {
    const first = setup();
    const second = setup();
    const third = setup();

    await first.client.send(payload);
    await second.client.send(payload);
    await third.client.send({ ...payload, subject: "Order 43" });

    const signature = (fake: FetchFake) => theRequest(fake).headers.authorization;
    expect(signature(first.fetchFake)).toBe(signature(second.fetchFake));
    expect(signature(third.fetchFake)).not.toBe(signature(first.fetchFake));
  });

  it("uses the credentials it is given, so another key gives another credential scope", async () => {
    const fetchFake: FetchFake = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 })));
    const client = new HttpPartnerClient({
      url: URL_OF_PARTNER,
      region: "eu-north-1",
      credentials: () => ({ accessKeyId: "AKIDOTHER", secretAccessKey: "other-secret" }),
      fetch: fetchFake,
      now: () => FIXED_NOW,
    });

    await client.send(payload);

    const { headers } = theRequest(fetchFake);
    expect(headers.authorization).toContain("Credential=AKIDOTHER/20260921/eu-north-1/lambda/aws4_request");
    // No session token was given, so none is sent.
    expect(headers).not.toHaveProperty("x-amz-security-token");
  });

  it("throws (it is our setup problem, not a partner answer) when there are no credentials", async () => {
    const client = new HttpPartnerClient({
      url: URL_OF_PARTNER,
      region: "eu-north-1",
      credentials: () => credentialsFromEnv({}),
      fetch: vi.fn<typeof fetch>(),
    });

    await expect(client.send(payload)).rejects.toThrow("AWS credentials are missing");
  });
});

describe("HttpPartnerClient: the answer", () => {
  it.each([200, 201, 202, 204])("%i is delivered", async (status) => {
    const { client } = setup(() => new Response(null, { status }));

    expect(await client.send(payload)).toEqual({ kind: "delivered", statusCode: status });
  });

  it.each([401, 403, 408, 429, 500, 502, 503, 504])("%i is retryable", async (status) => {
    const { client } = setup(() => new Response(null, { status }));

    expect(await client.send(payload)).toEqual({
      kind: "retryable",
      reason: `http_${status}`,
      statusCode: status,
    });
  });

  it.each([400, 404, 409, 410, 422])("%i is rejected for good", async (status) => {
    const { client } = setup(() => new Response(null, { status }));

    expect(await client.send(payload)).toEqual({ kind: "rejected", statusCode: status });
  });

  it("treats 401 and 403 as our own credential problem, not as a refusal by the partner", async () => {
    for (const status of [401, 403]) {
      const { client } = setup(() => new Response(null, { status }));

      expect((await client.send(payload)).kind).toBe("retryable");
    }
  });

  it("treats a timeout as retryable", async () => {
    const { client } = setup(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    expect(await client.send(payload)).toEqual({ kind: "retryable", reason: "timeout" });
  });

  it("treats a network error as retryable", async () => {
    const { client } = setup(() => {
      throw new TypeError("fetch failed");
    });

    expect(await client.send(payload)).toEqual({ kind: "retryable", reason: "network_error" });
  });

  it("does not put the response body into the result", async () => {
    const { client } = setup(() => new Response('{"error":"secret detail"}', { status: 422 }));

    expect(JSON.stringify(await client.send(payload))).not.toContain("secret detail");
  });
});

describe("credentialsFromEnv", () => {
  it("reads the three variables Lambda sets", () => {
    expect(
      credentialsFromEnv({
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "token",
      }),
    ).toEqual({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" });
  });

  it("works without a session token", () => {
    expect(credentialsFromEnv({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }).sessionToken).toBeUndefined();
  });

  it.each([
    ["no key id", { AWS_SECRET_ACCESS_KEY: "b" }],
    ["no secret", { AWS_ACCESS_KEY_ID: "a" }],
    ["empty values", { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" }],
  ])("throws with %s", (_label, env) => {
    expect(() => credentialsFromEnv(env)).toThrow("AWS credentials are missing");
  });
});
