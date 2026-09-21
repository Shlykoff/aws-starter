// What came back from one attempt to call the recipient, as plain data. No HTTP library
// type appears here: the client (src/clients/http-partner-client.ts) fills it in and the
// reply reader (src/domain/reply-reader.ts) decides what it means.
export type PartnerAnswer =
  | {
      kind: "answer";
      httpStatus: number;
      /** The body decoded as UTF-8, or `undefined` when there is none or it cannot be used. */
      body: string | undefined;
      /** Why `body` is `undefined` although the recipient may have sent one. Absent: no body. */
      bodyProblem?: "too_large" | "unreadable";
    }
  // Nobody answered: `reason` is a fixed word for the logs, never text from the network.
  | { kind: "no-answer"; reason: "timeout" | "network_error" };
