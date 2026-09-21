import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SsmApiKeyProvider } from "../../src/repositories/ssm-api-key-provider";
import { captureLogs } from "../helpers/logs";

// The real provider, with SSM replaced by a recorder and the clock by a number the test moves.
const ssm = mockClient(SSMClient);
const PARAMETER = "/demo/dev/partner-api-key";
const MINUTE = 60_000;

let clock = 0;
const provider = () => new SsmApiKeyProvider(new SSMClient({}), PARAMETER, () => clock);
const reads = () => ssm.commandCalls(GetParameterCommand).length;
const answer = (value: string) => ({ Parameter: { Name: PARAMETER, Value: value } });

beforeEach(() => {
  ssm.reset();
  clock = 1_000_000;
});
afterAll(() => {
  ssm.restore();
});

describe("SsmApiKeyProvider", () => {
  it("reads the parameter decrypted", async () => {
    ssm.on(GetParameterCommand).resolves(answer("key-1"));

    expect(await provider().get()).toBe("key-1");

    expect(ssm.commandCalls(GetParameterCommand)[0]?.args[0].input).toEqual({ Name: PARAMETER, WithDecryption: true });
  });

  it("keeps the key for 5 minutes and reads it again after that", async () => {
    ssm.on(GetParameterCommand).resolvesOnce(answer("key-1")).resolvesOnce(answer("key-2"));
    const keys = provider();

    expect(await keys.get()).toBe("key-1");
    clock += 5 * MINUTE - 1;
    expect(await keys.get()).toBe("key-1");
    expect(reads()).toBe(1);

    clock += 1; // exactly 5 minutes after the read
    expect(await keys.get()).toBe("key-2");
    expect(reads()).toBe(2);
  });

  it("does not keep a failure: the next call asks again", async () => {
    ssm.on(GetParameterCommand).rejectsOnce(new Error("throttled")).resolves(answer("key-1"));
    const keys = provider();

    await expect(keys.get()).rejects.toThrow("throttled");
    expect(await keys.get()).toBe("key-1");
    expect(reads()).toBe(2);
  });

  it.each([
    ["a missing parameter", () => ssm.on(GetParameterCommand).rejects(new ParameterNotFound({ message: "nope", $metadata: {} }))],
    ["a parameter without a value", () => ssm.on(GetParameterCommand).resolves({ Parameter: { Name: PARAMETER } })],
    ["an empty value", () => ssm.on(GetParameterCommand).resolves(answer(""))],
  ])("throws for %s, and does not keep that either", async (_label, arrange) => {
    arrange();
    const keys = provider();

    await expect(keys.get()).rejects.toThrow();
    await expect(keys.get()).rejects.toThrow();
    expect(reads()).toBe(2);
  });

  it("lets callers that arrive during a read share it", async () => {
    ssm.on(GetParameterCommand).resolves(answer("key-1"));
    const keys = provider();

    const values = await Promise.all([keys.get(), keys.get(), keys.get()]);

    expect(values).toEqual(["key-1", "key-1", "key-1"]);
    expect(reads()).toBe(1);
  });

  it("lets callers share a failed read too, and asks again afterwards", async () => {
    ssm.on(GetParameterCommand).rejectsOnce(new Error("throttled")).resolves(answer("key-1"));
    const keys = provider();

    const results = await Promise.allSettled([keys.get(), keys.get()]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(reads()).toBe(1);
    expect(await keys.get()).toBe("key-1");
  });

  describe("invalidate", () => {
    it("makes the next call read the key again (the recipient answered 401 or 403)", async () => {
      ssm.on(GetParameterCommand).resolvesOnce(answer("old-key")).resolvesOnce(answer("rotated-key"));
      const keys = provider();

      expect(await keys.get()).toBe("old-key");
      keys.invalidate();

      expect(await keys.get()).toBe("rotated-key");
      expect(reads()).toBe(2);
    });

    it("does nothing harmful when there is nothing to forget", async () => {
      ssm.on(GetParameterCommand).resolves(answer("key-1"));
      const keys = provider();

      keys.invalidate();

      expect(await keys.get()).toBe("key-1");
      expect(reads()).toBe(1);
    });

    it("does not let a read that started before it put an old key into the cache", async () => {
      // The first read is slow, and returns the OLD key after invalidate() was called.
      let releaseOld: () => void = () => undefined;
      const oldKeyArrives = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      ssm
        .on(GetParameterCommand)
        .callsFakeOnce(async () => {
          await oldKeyArrives;
          return answer("old-key");
        })
        .resolves(answer("rotated-key"));
      const keys = provider();

      const first = keys.get();
      keys.invalidate();
      const second = keys.get(); // starts its own read: the old one is no longer waited for
      releaseOld();

      expect(await first).toBe("old-key"); // the caller that was already waiting gets what it asked for
      expect(await second).toBe("rotated-key");
      expect(await keys.get()).toBe("rotated-key"); // and the old key was not kept
      expect(reads()).toBe(2);
    });
  });

  it("never logs the key", async () => {
    const logs = captureLogs();
    ssm.on(GetParameterCommand).resolves(answer("super-secret-key"));
    const keys = provider();

    await keys.get();
    keys.invalidate();
    await keys.get();

    expect(logs.lines).toEqual([]);
  });
});
