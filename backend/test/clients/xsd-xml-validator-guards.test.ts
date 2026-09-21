import { beforeEach, describe, expect, it, vi } from "vitest";
import { XsdXmlValidator } from "../../src/clients/xsd-xml-validator";
import { XSD_DIRECTORY, fixture } from "../helpers/contracts";

// Here xmllint-wasm is replaced by a spy, to prove what the validator does NOT hand to it:
// a document that has to be refused on its raw text never reaches the parser at all.
const { validateXML } = vi.hoisted(() => ({ validateXML: vi.fn() }));
vi.mock("xmllint-wasm", () => ({ validateXML }));

const validator = new XsdXmlValidator(XSD_DIRECTORY);
const accepted = fixture("reply", "valid/accepted.xml");

beforeEach(() => {
  validateXML.mockReset();
  validateXML.mockResolvedValue({ valid: true, errors: [], rawOutput: "", normalized: "" });
});

describe("what is refused before the parser sees it", () => {
  it.each([
    ["a DOCTYPE", `<?xml version="1.0"?><!DOCTYPE Reply []>${accepted}`, "DOCTYPE not allowed"],
    ["a lower-case doctype", accepted.replace("<Reply", "<!doctype x><Reply"), "DOCTYPE not allowed"],
    ["an ENTITY declaration on its own", accepted.replace("<Reply", "<!ENTITY a 'b'><Reply"), "DOCTYPE not allowed"],
    ["a document that declares UTF-16", accepted.replace('encoding="UTF-8"', 'encoding="UTF-16"'), "encoding must be UTF-8"],
    ["a document that declares Latin-1", accepted.replace('encoding="UTF-8"', "encoding='ISO-8859-1'"), "encoding must be UTF-8"],
    ["a document over 64 KiB", accepted + " ".repeat(64 * 1024), "document too large"],
  ])("%s", async (_label, xml, rule) => {
    const result = await validator.validateReply(xml);

    expect(result).toEqual({ valid: false, findings: [{ element: "(document)", rule }] });
    expect(validateXML).not.toHaveBeenCalled();
  });

  it("counts the size limit in bytes: exactly 65 536 pass, one more is refused", async () => {
    const padding = (bytes: number) => `${accepted}${"x".repeat(bytes - Buffer.byteLength(accepted))}`;

    await validator.validateReply(padding(65_536));
    expect(validateXML).toHaveBeenCalledTimes(1);

    const result = await validator.validateReply(padding(65_537));
    expect(result).toEqual({ valid: false, findings: [{ element: "(document)", rule: "document too large" }] });
    expect(validateXML).toHaveBeenCalledTimes(1);
  });

  it("lets the documents of the contract through: UTF-8 in either spelling, with or without a BOM", async () => {
    for (const xml of [
      accepted,
      accepted.replace('encoding="UTF-8"', "encoding='utf-8'"),
      `﻿${accepted}`,
      accepted.replace('<?xml version="1.0" encoding="UTF-8"?>\n', ""),
    ]) {
      await validator.validateReply(xml);
    }

    expect(validateXML).toHaveBeenCalledTimes(4);
  });
});

describe("what is handed to the parser", () => {
  it("is the document, the schema first, and the shared types as a preloaded file", async () => {
    await validator.validateSubmission(fixture("submission", "valid/minimal.xml"));

    const options = validateXML.mock.calls[0]?.[0] as {
      xml: { contents: string }[];
      schema: { fileName: string; contents: string }[];
      preload: { fileName: string }[];
    };
    expect(options.xml[0]?.contents).toBe(fixture("submission", "valid/minimal.xml"));
    expect(options.schema.map((file) => file.fileName)).toEqual(["submission.xsd"]);
    expect(options.schema[0]?.contents).toContain('targetNamespace="urn:aws-starter:submission:v1"');
    expect(options.preload.map((file) => file.fileName)).toEqual(["common-types.xsd"]);
  });

  it("uses reply.xsd for a reply", async () => {
    await validator.validateReply(accepted);

    const options = validateXML.mock.calls[0]?.[0] as { schema: { fileName: string }[] };
    expect(options.schema.map((file) => file.fileName)).toEqual(["reply.xsd"]);
  });
});

describe("when the validator itself cannot run", () => {
  it("throws, and the message does not repeat what xmllint said (it can quote the document)", async () => {
    validateXML.mockRejectedValue(Object.assign(new Error("Element 'Name': The value 'Secret Person' is broken"), { code: 9 }));

    const failure = validator.validateSubmission(fixture("submission", "valid/minimal.xml"));

    await expect(failure).rejects.toThrow("XSD validation could not run (exit code 9)");
    await expect(failure).rejects.not.toThrow(/Secret Person/);
  });

  it("says so even when there is no exit code", async () => {
    validateXML.mockRejectedValue(new Error("out of memory: Secret Person"));

    await expect(validator.validateReply(accepted)).rejects.toThrow(/^XSD validation could not run$/);
  });
});
