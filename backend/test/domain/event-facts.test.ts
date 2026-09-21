import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseOccurredAt, readEventFacts } from "../../src/domain/event-facts";
import { CONTRACTS, expected } from "../helpers/contracts";

const NS = "urn:aws-starter:event:v1";
const EVENT_ID = "3f0c6b1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c";
const REQUEST = "01M30JDSMHY8CRX59V35WV731S";
const fixture = (name: string): string => readFileSync(new URL(`fixtures/event/${name}`, CONTRACTS), "utf8");

describe("readEventFacts", () => {
  it("reads the values of the valid fixtures", () => {
    expect(readEventFacts(fixture("valid/approved.xml"))).toEqual({
      eventId: EVENT_ID,
      occurredAtMs: Date.UTC(2026, 8, 21, 10, 15, 32),
      relatesTo: REQUEST,
      decision: "Approved",
    });
    expect(readEventFacts(fixture("valid/declined-with-reason.xml"))).toEqual({
      eventId: EVENT_ID,
      occurredAtMs: Date.UTC(2026, 8, 21, 10, 15, 32, 250),
      relatesTo: REQUEST,
      decision: "Declined",
      reason: "Out of stock",
    });
    expect(readEventFacts(fixture("valid/cyrillic-reason.xml"))?.reason).toBe("Нет в наличии");
  });

  it("leaves `reason` out when there is none, instead of setting it to undefined", () => {
    expect(readEventFacts(fixture("valid/approved.xml"))).not.toHaveProperty("reason");
  });

  it("converts an offset to UTC and decodes the entities of the reason", () => {
    const facts = readEventFacts(fixture("valid/offset-time-zone.xml"));

    expect(facts?.occurredAtMs).toBe(Date.UTC(2026, 9, 21, 10, 15, 32)); // 14:15:32+04:00
    expect(facts?.reason).toBe("Paid by card & confirmed <today>");
  });

  it("reads every fixture that is valid, whatever its decision", () => {
    for (const name of Object.entries(expected.event).filter(([, want]) => want === "valid").map(([file]) => file)) {
      expect(readEventFacts(fixture(name))).toBeDefined();
    }
  });

  // The same event can be written in many ways. What is read must be what the schema saw.
  describe("the same values whichever way the document is written", () => {
    const fields = (prefix = "") =>
      `<${prefix}EventId>${EVENT_ID}</${prefix}EventId><${prefix}OccurredAt>2026-09-21T10:15:32Z</${prefix}OccurredAt><${prefix}RelatesTo>${REQUEST}</${prefix}RelatesTo>`;

    it("with a namespace prefix instead of the default namespace", () => {
      const xml = `<?xml version="1.0"?><e:DecisionEvent xmlns:e="${NS}" version="1">${fields("e:")}<e:Decision>Declined</e:Decision><e:Reason>why</e:Reason></e:DecisionEvent>`;

      expect(readEventFacts(xml)).toMatchObject({ decision: "Declined", reason: "why", eventId: EVENT_ID });
    });

    it("with comments and processing instructions that look like elements", () => {
      const xml = `<DecisionEvent xmlns="${NS}" version="1"><!-- <Decision>Declined</Decision> --><?pi <Decision>Declined</Decision>?>${fields()}<Decision>Approved</Decision></DecisionEvent>`;

      expect(readEventFacts(xml)).toMatchObject({ decision: "Approved" });
    });

    it("with a comment or CDATA inside a value, and character references", () => {
      const xml = `<DecisionEvent xmlns="${NS}" version="1">${fields()}<Decision>Appr<!-- x -->oved</Decision><Reason><![CDATA[<b>1 & 2</b>]]> a &amp; b &lt; c &#65;</Reason></DecisionEvent>`;

      expect(readEventFacts(xml)).toMatchObject({ decision: "Approved", reason: "<b>1 & 2</b> a & b < c A" });
    });

    it("with other attribute quoting, whitespace and a redeclared default namespace", () => {
      const xml = `<DecisionEvent version='1'   xmlns='${NS}'>\n\n${fields()}\n<Decision>Approved</Decision>\n</DecisionEvent>`;

      expect(readEventFacts(xml)).toMatchObject({ decision: "Approved", relatesTo: REQUEST });
    });

    it("with spaces around the date, which XSD ignores", () => {
      const xml = fixture("valid/approved.xml").replace("<OccurredAt>2026", "<OccurredAt>\n  2026").replace("Z</OccurredAt>", "Z </OccurredAt>");

      expect(readEventFacts(xml)?.occurredAtMs).toBe(Date.UTC(2026, 8, 21, 10, 15, 32));
    });
  });

  describe("returns undefined when the document does not have the shape of an event", () => {
    const valid = fixture("valid/approved.xml");
    it.each([
      ["not XML", "this is not xml"],
      ["an empty string", ""],
      ["a mismatched tag", "<DecisionEvent><a></DecisionEvent>"],
      ["another root element", `<Other xmlns="${NS}"/>`],
      ["the right root in another namespace", valid.replace(NS, "urn:other")],
      ["no EventId", valid.replace(/<EventId>.*<\/EventId>/, "")],
      ["no OccurredAt", valid.replace(/<OccurredAt>.*<\/OccurredAt>/, "")],
      ["no RelatesTo", valid.replace(/<RelatesTo>.*<\/RelatesTo>/, "")],
      ["no Decision", valid.replace(/<Decision>.*<\/Decision>/, "")],
      ["a decision that is not one of the two", valid.replace("Approved", "Maybe")],
      ["a decision in lower case", valid.replace("Approved", "approved")],
      ["an OccurredAt that is not a date", valid.replace("2026-09-21T10:15:32Z", "yesterday")],
      ["an OccurredAt without a time zone", valid.replace("2026-09-21T10:15:32Z", "2026-09-21T10:15:32")],
    ])("%s", (_label, xml) => {
      expect(readEventFacts(xml)).toBeUndefined();
    });
  });

  it("prints nothing when it refuses a document (the parser's own messages quote the document)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // A document that xmldom complains about: text outside the root element, and a BOM.
    expect(readEventFacts(`﻿${fixture("valid/approved.xml")}`)).toBeUndefined();
    expect(readEventFacts("CANARY-7c1 <DecisionEvent")).toBeUndefined();

    expect([error, warn, log].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
  });
});

describe("parseOccurredAt", () => {
  it.each([
    ["2026-09-21T10:15:32Z", Date.UTC(2026, 8, 21, 10, 15, 32)],
    ["2026-09-21T10:15:32.250Z", Date.UTC(2026, 8, 21, 10, 15, 32, 250)],
    ["2026-09-21T10:15:32.123456789Z", Date.UTC(2026, 8, 21, 10, 15, 32, 123)], // more than milliseconds: cut
    ["2026-10-21T14:15:32+04:00", Date.UTC(2026, 9, 21, 10, 15, 32)],
    ["2026-09-21T10:15:32-05:30", Date.UTC(2026, 8, 21, 15, 45, 32)],
    ["2026-09-21T10:15:32+14:00", Date.UTC(2026, 8, 20, 20, 15, 32)],
    ["2026-09-21T24:00:00Z", Date.UTC(2026, 8, 22)], // XSD allows the end of the day
    [" 2026-09-21T10:15:32Z\n", Date.UTC(2026, 8, 21, 10, 15, 32)],
    ["0001-01-01T00:00:00Z", -62_135_596_800_000], // the earliest year of the four-digit form
  ])("reads %j", (text, milliseconds) => {
    expect(parseOccurredAt(text)).toBe(milliseconds);
  });

  it("gives the same moment for the same instant written in two offsets", () => {
    expect(parseOccurredAt("2026-09-21T12:00:00+04:00")).toBe(parseOccurredAt("2026-09-21T08:00:00Z"));
  });

  // Not a point in time, or not a shape that event.xsd allows: refused, so the answer is 422.
  it.each([
    "",
    "yesterday",
    "2026-09-21",
    "2026-09-21T10:15:32", // no time zone
    "2026-09-21T10:15:32+0400", // an offset needs its colon
    "2026-09-21 10:15:32Z",
    "Sep 21 2026 10:15:32 GMT", // Date.parse would take this one; the shape check does not
    "12026-09-21T10:15:32Z", // valid XSD (five-digit year), not supported
    "-0001-09-21T10:15:32Z", // valid XSD (negative year), not supported
    "2026-13-01T10:15:32Z",
    "2026-09-21T10:15:32+99:99",
    "2026-09-21T10:15:32.Z",
  ])("refuses %j", (text) => {
    expect(parseOccurredAt(text)).toBeUndefined();
  });
});
