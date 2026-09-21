import { z } from "zod";
import { ApiError } from "./errors";
import { createTraceHeaderValue } from "./trace-header";

// Lambda timeout is 10 s and API Gateway's is 29 s; if nothing came back after 15 s the
// user is better served by an error message than by a spinner that never ends.
const REQUEST_TIMEOUT_MS = 15_000;

// The error body our Lambdas return: { "error": { "code", "message", "details"? } }.
// A 401 from API Gateway has a different body ({"message":"Unauthorized"}) and is handled
// before this schema is used.
const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export interface ApiClientOptions {
  // Base URL without a trailing slash, including the stage, e.g.
  // https://xxxx.execute-api.eu-north-1.amazonaws.com/v1 (paths are appended to it).
  baseUrl: string;
  // Returns the current ACCESS token (not the id token), or null when there is none.
  // A function, not a string, so a token renewed in the background is picked up.
  // The client does not know about Cognito or MobX: the app layer wires those in.
  getAccessToken: () => Promise<string | null>;
  // Called on a 401 (and when there is no token at all) so the app can drop the session.
  onUnauthorized: () => void | Promise<void>;
  // Only tests pass this; production uses the browser's fetch.
  fetchImpl?: typeof fetch;
}

// Responses are returned as `unknown`: the caller validates the shape (with zod) because
// only the caller knows what it expects.
export interface ApiClient {
  get(path: string): Promise<unknown>;
  // `body` is left out for a POST that carries no data (POST /requests/{id}/retry).
  post(path: string, body?: unknown): Promise<unknown>;
}

// Methods that only read; every other method changes something (see send).
const READ_ONLY_METHODS: readonly string[] = ["GET", "HEAD"];

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl, getAccessToken, onUnauthorized } = options;
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function rejectUnauthorized(): Promise<never> {
    await onUnauthorized();
    throw new ApiError(401, "unauthorized", "Your session has expired. Please sign in again.");
  }

  async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const token = await getAccessToken();
    if (!token) {
      // Signed out, or the token expired and could not be renewed: the API would answer
      // 401 anyway, so skip the round trip.
      return rejectUnauthorized();
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      // The raw token, no "Bearer " prefix: the REST API Cognito authorizer reads the token
      // straight from this header, and its documentation shows no prefix.
      Authorization: token,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // A request that changes something is a user action: its X-Ray trace starts here, with an
    // id made in the browser and a fresh one for every request. Reads do not get one.
    if (!READ_ONLY_METHODS.includes(method)) headers["X-Amzn-Trace-Id"] = createTraceHeaderValue();

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // fetch only rejects when no response was received (offline, DNS, CORS, timeout).
      throw new ApiError(0, "network_error", "Cannot reach the server. Check your connection and try again.");
    }

    // API Gateway answers 401 itself, before any Lambda runs, with its own body shape.
    if (response.status === 401) return rejectUnauthorized();

    // A body that is not JSON becomes `undefined` instead of throwing here.
    const data: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsed = errorBodySchema.safeParse(data);
      if (parsed.success) {
        const { code, message, details } = parsed.data.error;
        throw new ApiError(response.status, code, message, details);
      }
      throw new ApiError(response.status, "http_error", `The request failed (HTTP ${response.status}).`);
    }

    return data;
  }

  return {
    get: (path) => send("GET", path),
    post: (path, body) => send("POST", path, body),
  };
}
