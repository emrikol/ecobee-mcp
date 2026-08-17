import { describe, expect, it } from "vitest";
import { EcobeeResponseLimitError } from "../../src/ecobee/api.js";
import { schema as s } from "../../src/schema.js";
import {
  jsonByteLength,
  MAX_TOOL_RESULT_BYTES,
  structuredResult,
} from "../../src/tools/contracts.js";

const largeOutputSchema = s.object({
  data: s.string().max(300 * 1024),
});

describe("jsonByteLength", () => {
  it("matches JSON.stringify for a deterministic generated JSON domain", () => {
    const random = seededRandom(0x5ec0bee);
    const edgeValues: unknown[] = [
      null,
      true,
      false,
      0,
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      'quote"slash\\control\n',
      "é漢😀",
      "\ud800",
      [undefined, "value"],
      { omitted: undefined, retained: null },
    ];
    for (const value of edgeValues) assertExactJsonBytes(value);
    for (let index = 0; index < 1_000; index++) {
      assertExactJsonBytes(generatedJson(random, 0));
    }
  });

  it("rejects cycles just like JSON.stringify", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => jsonByteLength(value)).toThrow(TypeError);
  });
});

function assertExactJsonBytes(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toBeUndefined();
  expect(jsonByteLength(value)).toBe(Buffer.byteLength(serialized!, "utf8"));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function generatedJson(random: () => number, depth: number): unknown {
  const scalar = (): unknown => {
    switch (Math.floor(random() * 5)) {
      case 0:
        return null;
      case 1:
        return random() < 0.5;
      case 2:
        return Math.round((random() - 0.5) * 2_000_000) / 10;
      default:
        return generatedString(random);
    }
  };
  if (depth >= 4 || random() < 0.45) return scalar();
  const length = Math.floor(random() * 6);
  if (random() < 0.5) {
    return Array.from({ length }, () => generatedJson(random, depth + 1));
  }
  const object: Record<string, unknown> = {};
  for (let index = 0; index < length; index++) {
    object[`${generatedString(random)}-${index}`] = generatedJson(
      random,
      depth + 1,
    );
  }
  return object;
}

function generatedString(random: () => number): string {
  const alphabet = ["a", '"', "\\", "\n", "\u0000", "é", "漢", "😀", "\ud800"];
  const length = Math.floor(random() * 12);
  let result = "";
  for (let index = 0; index < length; index++) {
    result += alphabet[Math.floor(random() * alphabet.length)];
  }
  return result;
}

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
