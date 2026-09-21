import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpPartnerClient, MAX_REPLY_BYTES } from "../../src/clients/http-partner-client";
import { captureLogs } from "../helpers/logs";

// The real client, with `fetch` replaced. The client does HTTP and nothing else: the tests
// check what goes out (URL, headers, body, the options that protect the API key) and how
// whatever comes back is turned into a PartnerAnswer. What an answer MEANS is tested with the
// reply reader.
const ID = "01J8Z3K5W0ABCDEFGHJKMNPQR1";
const SUBMISSION = { xml: "<Submission>é</Submission>", idempotencyKey: ID, apiKey: "secret-key-1" };

const fetchFake = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchFake.mockReset();
});
const clientFor = (baseUrl = "https://partner.example.test") => new HttpPartnerClient({ baseUrl, fetch: fetchFake });
const respond = (...responses: Response[]) => {
  for (const response of responses) fetchFake.mockResolvedValueOnce(response);
};

// A body that arrives in the chunks given, as it does over a real connection.
function chunked(...chunks: (string | Uint8Array)[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("the request", () => {
  it("POSTs the XML to /v1/submissions with the five headers of the contract", async () => {
    respond(new Response("<Reply/>", { status: 200 }));

    await clientFor().send(SUBMISSION);

    const [url, init] = fetchFake.mock.calls[0] ?? [];
    expect(url).toBe("https://partner.example.test/v1/submissions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "X-API-Key": "secret-key-1",
      "Content-Type": "application/xml",
      "Idempotency-Key": ID,
      "User-Agent": "aws-starter-worker/1",
      Accept: "application/xml",
    });
    expect(init?.body).toBe("<Submission>é</Submission>");
  });

  it.each(["https://partner.example.test", "https://partner.example.test/", "http://127.0.0.1:8080"])(
    "adds the path to the base address %s",
    async (baseUrl) => {
      respond(new Response(null, { status: 200 }));

      await clientFor(baseUrl).send(SUBMISSION);

      expect(fetchFake.mock.calls[0]?.[0]).toBe(`${new URL(baseUrl).origin}/v1/submissions`);
    },
  );

  it("does not follow redirects: the API key must not travel to another host", async () => {
    respond(new Response(null, { status: 200 }));

    await clientFor().send(SUBMISSION);

    expect(fetchFake.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("gives the whole exchange 8 seconds", async () => {
    respond(new Response(null, { status: 200 }));
    const spy = vi.spyOn(AbortSignal, "timeout");

    await clientFor().send(SUBMISSION);

    expect(spy).toHaveBeenCalledWith(8000);
    expect(fetchFake.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("nobody answered", () => {
  it("reports a timeout", async () => {
    fetchFake.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    expect(await clientFor().send(SUBMISSION)).toEqual({ kind: "no-answer", reason: "timeout" });
  });

  it.each([
    ["a connection problem", new TypeError("fetch failed")],
    ["an abort that is not a timeout", new DOMException("aborted", "AbortError")],
  ])("reports %s as a network error, without its text", async (_label, error) => {
    fetchFake.mockRejectedValueOnce(error);

    expect(await clientFor().send(SUBMISSION)).toEqual({ kind: "no-answer", reason: "network_error" });
  });
});

describe("what came back", () => {
  it("returns the status and the body as text, decoded as UTF-8", async () => {
    respond(new Response("<Reply>é😀</Reply>", { status: 422 }));

    expect(await clientFor().send(SUBMISSION)).toEqual({ kind: "answer", httpStatus: 422, body: "<Reply>é😀</Reply>" });
  });

  it("returns a redirect as an answer, without following it", async () => {
    respond(new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.test/" } }));

    expect(await clientFor().send(SUBMISSION)).toEqual({ kind: "answer", httpStatus: 302, body: undefined });
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no body at all", () => new Response(null, { status: 401 })],
    ["an empty body", () => new Response("", { status: 503, headers: { "Retry-After": "1" } })],
  ])("returns %s as body undefined", async (_label, make) => {
    respond(make());

    const answer = await clientFor().send(SUBMISSION);

    expect(answer).toMatchObject({ kind: "answer", body: undefined });
    expect(answer).not.toHaveProperty("bodyProblem");
  });

  it("puts together a character that is split between two chunks", async () => {
    const bytes = new TextEncoder().encode("é😀");
    respond(chunked(bytes.slice(0, 1), bytes.slice(1, 4), bytes.slice(4)));

    expect(await clientFor().send(SUBMISSION)).toMatchObject({ body: "é😀" });
  });

  it("drops a byte order mark", async () => {
    respond(chunked(new Uint8Array([0xef, 0xbb, 0xbf]), "<Reply/>"));

    expect(await clientFor().send(SUBMISSION)).toMatchObject({ body: "<Reply/>" });
  });

  it("reports a body that is not UTF-8 as unreadable, and does not repair it", async () => {
    respond(chunked(new Uint8Array([0x3c, 0xff, 0xfe, 0x3e])));

    expect(await clientFor().send(SUBMISSION)).toEqual({
      kind: "answer",
      httpStatus: 200,
      body: undefined,
      bodyProblem: "unreadable",
    });
  });

  it("keeps the status when the connection breaks while the body arrives", async () => {
    respond(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<Rep"));
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200 },
      ),
    );

    expect(await clientFor().send(SUBMISSION)).toEqual({
      kind: "answer",
      httpStatus: 200,
      body: undefined,
      bodyProblem: "unreadable",
    });
  });
});

describe("the limit of 64 KiB for the body", () => {
  it("is 65 536 bytes", () => {
    expect(MAX_REPLY_BYTES).toBe(65_536);
  });

  it("accepts a body of exactly the limit", async () => {
    respond(chunked("x".repeat(MAX_REPLY_BYTES)));

    const answer = await clientFor().send(SUBMISSION);

    expect(answer).toMatchObject({ httpStatus: 200 });
    expect(answer.kind === "answer" && answer.body?.length).toBe(MAX_REPLY_BYTES);
  });

  it("refuses a body one byte over the limit, whatever the headers say", async () => {
    respond(chunked("x".repeat(MAX_REPLY_BYTES), "y"));

    expect(await clientFor().send(SUBMISSION)).toEqual({
      kind: "answer",
      httpStatus: 200,
      body: undefined,
      bodyProblem: "too_large",
    });
  });

  it("counts bytes, not characters", async () => {
    respond(chunked("😀".repeat(MAX_REPLY_BYTES / 4), "😀")); // 16 384 + 1 emoji = 65 540 bytes

    expect(await clientFor().send(SUBMISSION)).toMatchObject({ bodyProblem: "too_large" });
  });

  it("does not read a body that announces too much: it cancels the stream at once", async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
        if (pulled >= 200) controller.close(); // "never ends", but a broken client must fail this test, not hang it
      },
      cancel() {
        cancelled = true;
      },
    });
    respond(new Response(body, { status: 200, headers: { "content-length": String(MAX_REPLY_BYTES + 1) } }));

    const answer = await clientFor().send(SUBMISSION);

    expect(answer).toMatchObject({ bodyProblem: "too_large" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("stops reading a body that never ends as soon as it is over the limit", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16 * 1024));
        if (pulled >= 200) controller.close(); // "never ends", but a broken client must fail this test, not hang it
      },
      cancel() {
        cancelled = true;
      },
    });
    respond(new Response(endless, { status: 200 }));

    const answer = await clientFor().send(SUBMISSION);

    expect(answer).toMatchObject({ bodyProblem: "too_large" });
    expect(cancelled).toBe(true);
    // 4 chunks of 16 KiB reach the limit, the 5th goes over it; a few more may be queued ahead.
    expect(pulled).toBeLessThan(10);
  });
});

describe("what the client keeps quiet about", () => {
  it("writes nothing to the logs and does not return the key, whatever happens", async () => {
    const logs = captureLogs();
    const consoleSpy = vi.spyOn(console, "log");
    fetchFake.mockRejectedValueOnce(new TypeError("fetch failed: https://partner.example.test/v1/submissions"));
    respond(new Response("<Reply/>", { status: 200 }), new Response(null, { status: 302 }));

    const answers = [
      await clientFor().send(SUBMISSION),
      await clientFor().send(SUBMISSION),
      await clientFor().send(SUBMISSION),
    ];

    expect(logs.lines).toEqual([]);
    expect(consoleSpy).not.toHaveBeenCalled();
    const everything = JSON.stringify(answers);
    for (const secret of ["secret-key-1", "partner.example.test", "fetch failed"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
