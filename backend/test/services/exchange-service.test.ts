import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { Exchange } from "../../src/domain/exchange";
import { NotFoundError } from "../../src/lib/errors";
import type { ExchangeStore } from "../../src/repositories/exchange-store";
import type { RequestRepository } from "../../src/repositories/request-repository";
import { ExchangeService } from "../../src/services/exchange-service";
import { aRequest } from "../helpers/fakes";

const ID = ulid(Date.UTC(2026, 8, 20, 12, 0));
const exchange: Exchange = {
  attempt: 2,
  at: "2026-09-20T12:00:05.000Z",
  outcome: "retry",
  request: { xml: "<Submission/>", valid: true, problems: [] },
  reply: null,
};

// The journal shows the order of the calls: the owner is checked BEFORE S3 is touched.
function setup(options: { ownedBy?: string; stored?: Exchange; storeFails?: Error } = {}) {
  const journal: string[] = [];
  const requests: RequestRepository = {
    create: () => Promise.reject(new Error("not used")),
    listByOwner: () => Promise.reject(new Error("not used")),
    retry: () => Promise.reject(new Error("not used")),
    findById: (ownerId, id) => {
      journal.push(`requests.findById:${ownerId}`);
      return Promise.resolve(ownerId === (options.ownedBy ?? "user-a") ? aRequest({ id }) : undefined);
    },
  };
  const exchanges: ExchangeStore = {
    save: () => Promise.reject(new Error("not used")),
    find: (id) => {
      journal.push(`exchanges.find:${id}`);
      return options.storeFails ? Promise.reject(options.storeFails) : Promise.resolve(options.stored);
    },
  };
  return { journal, service: new ExchangeService(requests, exchanges) };
}

describe("ExchangeService.get", () => {
  it("returns the exchange of the caller's own request, after checking the owner", async () => {
    const { journal, service } = setup({ stored: exchange });

    expect(await service.get("user-a", ID)).toEqual(exchange);
    expect(journal).toEqual(["requests.findById:user-a", `exchanges.find:${ID}`]);
  });

  it("does not touch the store for a request that is not the caller's", async () => {
    const { journal, service } = setup({ stored: exchange });

    await expect(service.get("user-b", ID)).rejects.toThrow(NotFoundError);
    expect(journal).toEqual(["requests.findById:user-b"]);
  });

  it("does not touch the table or the store for an id that is not a ULID", async () => {
    const { journal, service } = setup({ stored: exchange });

    await expect(service.get("user-a", "not-an-id")).rejects.toThrow(NotFoundError);
    expect(journal).toEqual([]);
  });

  it("answers not found, with its own message, when nothing was recorded yet", async () => {
    const { service } = setup({ stored: undefined });

    await expect(service.get("user-a", ID)).rejects.toThrow("No delivery attempt recorded yet");
  });

  it("lets a failure of the store through: it must not look like 'no exchange yet'", async () => {
    const { service } = setup({ storeFails: new Error("AccessDenied") });

    await expect(service.get("user-a", ID)).rejects.toThrow("AccessDenied");
  });
});
