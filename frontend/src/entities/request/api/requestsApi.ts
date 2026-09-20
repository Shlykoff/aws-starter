import { z } from "zod";
import type { ApiClient } from "@/shared/api";
import { partnerRequestSchema, type NewPartnerRequest, type PartnerRequest } from "../model/types";

// GET /requests answers { items: Request[] }, newest first, at most 50.
const listResponseSchema = z.object({ items: z.array(partnerRequestSchema) });

// The three calls of docs/api.md. The store depends on this interface, not on fetch, so
// tests can hand it a fake.
export interface RequestsApi {
  list(): Promise<PartnerRequest[]>;
  get(id: string): Promise<PartnerRequest>;
  create(input: NewPartnerRequest): Promise<PartnerRequest>;
}

export function createRequestsApi(client: ApiClient): RequestsApi {
  return {
    async list() {
      const data = await client.get("/requests");
      return listResponseSchema.parse(data).items;
    },
    async get(id) {
      // encodeURIComponent: the id ends up in the URL path, never trust it to be plain.
      const data = await client.get(`/requests/${encodeURIComponent(id)}`);
      return partnerRequestSchema.parse(data);
    },
    async create(input) {
      const data = await client.post("/requests", input);
      return partnerRequestSchema.parse(data);
    },
  };
}
