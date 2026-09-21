import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { PartnerRequest } from "../../src/domain/request";
import { NotFoundError, NotRetryableError } from "../../src/lib/errors";
import type { RequestRepository, RetryOutcome } from "../../src/repositories/request-repository";
import { MAX_LIST_ITEMS, RequestService } from "../../src/services/request-service";

// An in-memory repository. Like the real one, it keeps each owner's requests apart.
class FakeRequestRepository implements RequestRepository {
  readonly byOwner = new Map<string, PartnerRequest[]>();
  readonly listLimits: number[] = [];
  failWith: Error | undefined;

  create(ownerId: string, request: PartnerRequest): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.byOwner.set(ownerId, [...(this.byOwner.get(ownerId) ?? []), request]);
    return Promise.resolve();
  }

  listByOwner(ownerId: string, limit: number): Promise<PartnerRequest[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.listLimits.push(limit);
    const newestFirst = [...(this.byOwner.get(ownerId) ?? [])].reverse();
    return Promise.resolve(newestFirst.slice(0, limit));
  }

  findById(ownerId: string, id: string): Promise<PartnerRequest | undefined> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.byOwner.get(ownerId)?.find((request) => request.id === id));
  }

  // Like the real one: only a failed request of THIS owner is moved back to created.
  readonly retryCalls: [ownerId: string, id: string][] = [];
  retry(ownerId: string, id: string): Promise<RetryOutcome> {
    this.retryCalls.push([ownerId, id]);
    if (this.failWith) return Promise.reject(this.failWith);
    const requests = this.byOwner.get(ownerId) ?? [];
    const index = requests.findIndex((request) => request.id === id);
    const found = requests[index];
    if (found === undefined) return Promise.resolve({ kind: "not_found" });
    if (found.status !== "failed") return Promise.resolve({ kind: "not_failed", status: found.status });
    const restarted: PartnerRequest = { ...found, status: "created" };
    requests[index] = restarted;
    return Promise.resolve({ kind: "restarted", request: restarted });
  }
}

const input = { partner: "Acme", subject: "Order 42", body: "Please ship." };
const fixedNow = new Date("2026-09-20T12:34:56.789Z");

function setup() {
  const repository = new FakeRequestRepository();
  let counter = 0;
  const service = new RequestService(
    repository,
    () => fixedNow,
    () => ulid(1_000_000 + counter++), // distinct, valid, increasing ULIDs
  );
  return { repository, service };
}

describe("RequestService.create", () => {
  it("returns the new request with status created, a ULID id and an ISO UTC timestamp", async () => {
    const { service } = setup();

    const created = await service.create("user-a", input);

    expect(created).toEqual({
      id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) as string,
      ...input,
      status: "created",
      createdAt: "2026-09-20T12:34:56.789Z",
    });
  });

  it("stores the request under the owner it was given", async () => {
    const { service, repository } = setup();

    const created = await service.create("user-a", input);

    expect(repository.byOwner.get("user-a")).toEqual([created]);
    expect(repository.byOwner.has("user-b")).toBe(false);
  });

  it("never puts the owner into the returned request", async () => {
    const { service } = setup();

    const created = await service.create("user-a", input);

    expect(Object.keys(created).sort()).toEqual(
      ["body", "createdAt", "id", "partner", "status", "subject"],
    );
  });

  it("does not swallow a storage failure", async () => {
    const { service, repository } = setup();
    repository.failWith = new Error("storage is down");

    await expect(service.create("user-a", input)).rejects.toThrow("storage is down");
  });

  it("uses a real clock and real ULIDs when none are injected", async () => {
    const service = new RequestService(new FakeRequestRepository());
    const before = Date.now();

    const created = await service.create("user-a", input);

    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Date.parse(created.createdAt)).toBeGreaterThanOrEqual(before);
  });
});

describe("RequestService.list", () => {
  it("returns the owner's requests, newest first", async () => {
    const { service } = setup();
    const first = await service.create("user-a", input);
    const second = await service.create("user-a", { ...input, subject: "Order 43" });

    expect(await service.list("user-a")).toEqual([second, first]);
  });

  it("asks the repository for at most 50 items", async () => {
    const { service, repository } = setup();

    await service.list("user-a");

    expect(MAX_LIST_ITEMS).toBe(50);
    expect(repository.listLimits).toEqual([50]);
  });

  it("returns an empty list for an owner without requests", async () => {
    const { service } = setup();
    await service.create("user-a", input);

    expect(await service.list("user-b")).toEqual([]);
  });
});

describe("RequestService.get", () => {
  it("returns the owner's request", async () => {
    const { service } = setup();
    const created = await service.create("user-a", input);

    expect(await service.get("user-a", created.id)).toEqual(created);
  });

  it("answers not found for another user's request, exactly like for a missing one", async () => {
    const { service } = setup();
    const created = await service.create("user-a", input);
    const missingId = ulid(2_000_000);

    const foreign = await service.get("user-b", created.id).catch((error: unknown) => error);
    const missing = await service.get("user-b", missingId).catch((error: unknown) => error);

    expect(foreign).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((foreign as NotFoundError).message).toBe((missing as NotFoundError).message);
  });

  it("answers not found for a malformed id without asking the repository", async () => {
    const { service, repository } = setup();
    let lookups = 0;
    repository.findById = () => {
      lookups += 1;
      return Promise.resolve(undefined);
    };

    await expect(service.get("user-a", "not-a-ulid")).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.get("user-a", "")).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.get("user-a", "x".repeat(5000))).rejects.toBeInstanceOf(NotFoundError);
    expect(lookups).toBe(0);
  });

  it("does not turn a storage failure into not found", async () => {
    const { service, repository } = setup();
    repository.failWith = new Error("storage is down");

    await expect(service.get("user-a", ulid(2_000_000))).rejects.toThrow("storage is down");
  });
});

describe("RequestService.retry", () => {
  // A stored request that the pipeline has moved to `status`.
  async function storedWithStatus(status: PartnerRequest["status"]) {
    const context = setup();
    const created = await context.service.create("user-a", input);
    const items = context.repository.byOwner.get("user-a") ?? [];
    items[0] = { ...created, status };
    return { ...context, id: created.id };
  }

  it("moves a failed request back to created and returns it", async () => {
    const { service, id } = await storedWithStatus("failed");

    const restarted = await service.retry("user-a", id);

    expect(restarted).toMatchObject({ id, status: "created", ...input });
  });

  it.each(["created", "queued", "sent", "rejected"] as const)(
    "refuses a %s request with not_retryable, and the message names the status",
    async (status) => {
      const { service, repository, id } = await storedWithStatus(status);

      const error = await service.retry("user-a", id).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotRetryableError);
      expect(error).toMatchObject({
        code: "not_retryable",
        message: `Only a failed request can be sent again (it is ${status})`,
      });
      expect(repository.byOwner.get("user-a")?.[0]?.status).toBe(status); // unchanged
    },
  );

  it("answers not found for an id the owner does not have, and for another owner's request", async () => {
    const { service, id } = await storedWithStatus("failed");

    await expect(service.retry("user-a", ulid(5_000))).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.retry("user-b", id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("answers not found for a malformed id without asking the repository", async () => {
    const { service, repository } = setup();

    for (const id of ["", "nope", "../../etc", "x".repeat(3000)]) {
      await expect(service.retry("user-a", id)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(repository.retryCalls).toEqual([]);
  });

  it("does not swallow a storage failure", async () => {
    const { service, repository, id } = await storedWithStatus("failed");
    repository.failWith = new Error("storage is down");

    await expect(service.retry("user-a", id)).rejects.toThrow("storage is down");
  });
});
