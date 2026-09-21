import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeExchange } from "@test/factories";
import type { ExchangeState } from "../model/ExchangeStore";
import type { Exchange } from "../model/types";
import { ExchangePanel } from "./ExchangePanel";

const ready = (exchange: Exchange): ExchangeState => ({ id: "r1", status: "ready", exchange });
const show = (state: ExchangeState | null, onRetry = () => undefined) =>
  render(<ExchangePanel state={state} onRetry={onRetry} />);

describe("ExchangePanel states", () => {
  it.each([
    ["nothing asked yet", null],
    ["loading", { id: "r1", status: "loading" } as const],
  ])("shows a loading placeholder when %s", (_name, state) => {
    show(state);

    expect(screen.getByRole("region", { name: "Exchange" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading exchange" })).toBeInTheDocument();
  });

  it("shows a calm empty state, not an error, when there is no delivery attempt yet", () => {
    show({ id: "r1", status: "empty" });

    expect(screen.getByText("No delivery attempt to show")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the error with a retry button", async () => {
    const onRetry = vi.fn();
    show({ id: "r1", status: "error", message: "Cannot reach the server." }, onRetry);

    expect(screen.getByRole("alert")).toHaveTextContent("Cannot reach the server.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("ExchangePanel with a delivered exchange", () => {
  it("shows the outcome, the attempt, the time and both documents", () => {
    const exchange = makeExchange({ attempt: 2, at: "2025-01-31T09:05:07.000Z" });
    show(ready(exchange));

    expect(screen.getByRole("heading", { name: "Exchange" })).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toHaveAttribute("data-outcome", "delivered");
    expect(screen.getByText("Attempt 2")).toBeInTheDocument();
    expect(document.querySelector("time")).toHaveAttribute("datetime", "2025-01-31T09:05:07.000Z");

    expect(screen.getByRole("heading", { name: "Sent" })).toBeInTheDocument();
    expect(screen.getByText("Valid against submission.xsd: yes")).toBeInTheDocument();
    // Shown exactly as recorded, not reformatted.
    expect(screen.getByRole("region", { name: "Request XML" }).textContent).toBe(exchange.request.xml);

    expect(screen.getByRole("heading", { name: "Received" })).toBeInTheDocument();
    const summary = screen.getByText("HTTP status").parentElement;
    expect(summary).toHaveTextContent("HTTP status200");
    expect(summary).toHaveTextContent("StatusAccepted");
    expect(screen.getByText("Valid against reply.xsd: yes")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Reply XML" }).textContent).toBe(exchange.reply?.xml);
    expect(screen.queryByText("Problems found")).not.toBeInTheDocument();
  });
});

describe("ExchangePanel with a refusal", () => {
  const refused = makeExchange({
    outcome: "refused",
    request: {
      xml: "<Submission/>",
      valid: true,
      problems: [],
    },
    reply: {
      httpStatus: 422,
      xml: "<Reply/>",
      valid: true,
      status: "Rejected",
      code: "SCHEMA_INVALID",
      description: "Element Recipient/Name: value does not match the allowed pattern",
    },
  });

  it("shows the parsed status, code and description of the partner's answer", () => {
    show(ready(refused));

    expect(screen.getByText("Refused")).toHaveAttribute("data-outcome", "refused");
    const summary = screen.getByText("HTTP status").parentElement;
    expect(summary).toHaveTextContent("HTTP status422");
    expect(summary).toHaveTextContent("StatusRejected");
    expect(summary).toHaveTextContent("CodeSCHEMA_INVALID");
    expect(summary).toHaveTextContent("Element Recipient/Name: value does not match the allowed pattern");
  });

  it("lists each problem of our own message as element and rule, and says it is not valid", () => {
    show(
      ready({
        ...refused,
        outcome: "invalid_request",
        request: {
          xml: "<Submission/>",
          valid: false,
          problems: [
            { element: "Recipient/Name", rule: "value does not match the pattern" },
            { element: "Subject", rule: "value is too long" },
          ],
        },
        reply: null,
      }),
    );

    expect(screen.getByText("Invalid request")).toHaveAttribute("data-outcome", "invalid_request");
    expect(screen.getByText("Valid against submission.xsd: no")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Recipient/Name — value does not match the pattern");
    expect(items[1]).toHaveTextContent("Subject — value is too long");
  });

  it("says when the partner's answer does not fit reply.xsd", () => {
    show(ready({ ...refused, reply: { httpStatus: 200, xml: "<nonsense/>", valid: false } }));

    expect(screen.getByText("Valid against reply.xsd: no")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Reply XML" })).toHaveTextContent("<nonsense/>");
    expect(screen.queryByText("Code")).not.toBeInTheDocument();
  });
});

describe("ExchangePanel without an answer", () => {
  it("says there was no answer from the partner after a temporary failure", () => {
    show(ready(makeExchange({ outcome: "retry", reply: null })));

    expect(screen.getByText("Temporary failure")).toHaveAttribute("data-outcome", "retry");
    expect(screen.getByText(/No answer from the partner/)).toBeInTheDocument();
    // What we sent is still there.
    expect(screen.getByRole("region", { name: "Request XML" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Reply XML" })).not.toBeInTheDocument();
  });

  it("says when the partner answered but sent no body", () => {
    show(ready(makeExchange({ outcome: "retry", reply: { httpStatus: 503, xml: null, valid: false } })));

    const received = screen.getByRole("heading", { name: "Received" }).parentElement as HTMLElement;
    expect(within(received).getByText("503")).toBeInTheDocument();
    expect(within(received).getByText("The answer had no body.")).toBeInTheDocument();
    expect(within(received).queryByText(/Valid against/)).not.toBeInTheDocument();
  });
});

describe("ExchangePanel with a request that could not be built", () => {
  const unrepresentable = makeExchange({
    outcome: "unrepresentable",
    request: { xml: "", valid: false, problems: [] },
    reply: null,
  });

  it("explains instead of showing an empty box, and says nothing was sent", () => {
    show(ready(unrepresentable));

    expect(screen.getByText("Cannot be sent as XML")).toHaveAttribute("data-outcome", "unrepresentable");
    expect(screen.getByText(/There is no XML to show/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Request XML" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Valid against/)).not.toBeInTheDocument();
    expect(screen.getByText("Nothing was sent, so there is no answer.")).toBeInTheDocument();
  });
});

describe("ExchangePanel shows untrusted text as text", () => {
  const hostileXml = '<script>alert("xss")</script><img src="x" onerror="alert(1)"><a href="javascript:alert(2)">click</a>';
  const hostileText = '<img src="x" onerror="alert(3)"> & <b>bold</b>';

  it("renders XML and the partner's description literally and creates no elements from them", () => {
    const { container } = show(
      ready(
        makeExchange({
          request: { xml: hostileXml, valid: false, problems: [{ element: "<b>Subject</b>", rule: hostileText }] },
          reply: {
            httpStatus: 422,
            xml: hostileXml,
            valid: false,
            status: "Rejected",
            code: "<i>CODE</i>",
            description: hostileText,
          },
        }),
      ),
    );

    // The characters are on the page ...
    expect(screen.getByRole("region", { name: "Request XML" }).textContent).toBe(hostileXml);
    expect(screen.getByRole("region", { name: "Reply XML" }).textContent).toBe(hostileXml);
    expect(screen.getByText(hostileText, { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("<i>CODE</i>")).toBeInTheDocument();
    expect(screen.getByText("<b>Subject</b>")).toBeInTheDocument();

    // ... but no element was made out of them.
    expect(container.querySelector("script, img, a, b, i")).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("ExchangePanel earlier attempt", () => {
  const note = "This is the earlier attempt; the new one replaces it when it has run.";

  it("says the record is an earlier attempt when the page asks for it", () => {
    render(<ExchangePanel state={ready(makeExchange())} onRetry={() => undefined} earlierAttempt />);

    expect(screen.getByText(note)).toBeInTheDocument();
    // The record itself is still shown.
    expect(screen.getByText("Attempt 1")).toBeInTheDocument();
  });

  it("says nothing by default, and nothing when there is no record to call earlier", () => {
    const { rerender } = render(<ExchangePanel state={ready(makeExchange())} onRetry={() => undefined} />);
    expect(screen.queryByText(note)).not.toBeInTheDocument();

    rerender(<ExchangePanel state={{ id: "r1", status: "empty" }} onRetry={() => undefined} earlierAttempt />);
    expect(screen.queryByText(note)).not.toBeInTheDocument();
  });
});
