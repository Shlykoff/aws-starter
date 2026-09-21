// A value for the X-Amzn-Trace-Id header, so that the X-Ray trace of a user action starts
// in the browser: API Gateway continues a trace whose id it is given instead of making one.
//
// The id is neither a secret nor personal data: it is a timestamp plus random numbers, and
// it identifies one request, not a person. The browser is not a node of the trace (it sends
// no segments to X-Ray); it is only the origin of the trace id.
//
// Format (AWS X-Ray "tracing header"):
//   Root=1-<8 hex: epoch seconds>-<24 hex: random>;Parent=<16 hex: random>;Sampled=1
// `Sampled=1` asks for the trace to be recorded.

// The two things that change from call to call, injectable so a test can pin them down.
export interface TraceHeaderSources {
  // Milliseconds since the epoch, like Date.now().
  nowMs: () => number;
  // `length` cryptographically random bytes.
  randomBytes: (length: number) => Uint8Array;
}

const defaultSources: TraceHeaderSources = {
  nowMs: () => Date.now(),
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};

// Every byte becomes exactly two hex characters ("0a", not "a").
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A new value on every call: one per request, never reused.
export function createTraceHeaderValue(sources: TraceHeaderSources = defaultSources): string {
  const epochSeconds = Math.floor(sources.nowMs() / 1000);
  const epochHex = epochSeconds.toString(16).padStart(8, "0");
  const traceRandom = toHex(sources.randomBytes(12)); // 12 bytes = 24 hex characters
  const parentId = toHex(sources.randomBytes(8)); // 8 bytes = 16 hex characters
  return `Root=1-${epochHex}-${traceRandom};Parent=${parentId};Sampled=1`;
}
