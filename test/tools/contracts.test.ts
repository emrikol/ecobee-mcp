import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EcobeeResponseLimitError } from "../../src/ecobee/api.js";
import {
  MAX_TOOL_RESULT_BYTES,
  structuredResult,
} from "../../src/tools/contracts.js";

const largeOutputSchema = z.object({
  data: z.string().max(300 * 1024),
});

describe("structuredResult", () => {
  it("uses compact text when a validated structured result nears the limit", () => {
    const result = structuredResult(largeOutputSchema, {
      data: "x".repeat(140 * 1024),
    });

    expect(result.content[0]).toEqual({
      type: "text",
      text: "Structured Ecobee result returned; use structuredContent for the complete validated data.",
    });
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
  });

  it("rejects a structured result that cannot fit even without duplicate text", () => {
    expect(() =>
      structuredResult(largeOutputSchema, {
        data: "x".repeat(260 * 1024),
      }),
    ).toThrow(EcobeeResponseLimitError);
  });

  it("does not serialize a second non-string representation", () => {
    const result = structuredResult(
      largeOutputSchema,
      { data: "value" },
      { summary: "compact" },
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: "Structured Ecobee result returned; use structuredContent for the complete validated data.",
    });
  });
});
