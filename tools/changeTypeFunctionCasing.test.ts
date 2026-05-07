import { describe, expect, it } from "bun:test";
import {
  ALLOWED_ID_CASES,
  ALLOWED_NAME_CASES,
  type Case,
  format,
  parseCaseName,
  tokenize,
} from "./lib/casing.ts";

const SAMPLES: Array<{ in: string; tokens: string[] }> = [
  { in: "is_strictly_comparable_to", tokens: ["is", "strictly", "comparable", "to"] },
  { in: "is-strictly-comparable-to", tokens: ["is", "strictly", "comparable", "to"] },
  { in: "IsStrictlyComparableTo", tokens: ["is", "strictly", "comparable", "to"] },
  { in: "isStrictlyComparableTo", tokens: ["is", "strictly", "comparable", "to"] },
  { in: "magnitude", tokens: ["magnitude"] },
  { in: "add", tokens: ["add"] },
];

describe("tokenize", () => {
  for (const s of SAMPLES) {
    it(`splits ${s.in}`, () => {
      expect(tokenize(s.in)).toEqual(s.tokens);
    });
  }
  it("returns [] on empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
  it("splits Upper run followed by capitalized word (HTTPRequest)", () => {
    expect(tokenize("HTTPRequest")).toEqual(["http", "request"]);
  });
});

describe("format", () => {
  const expected: Record<Case, string[]> = {
    lower_snake: [
      "is_strictly_comparable_to",
      "is_strictly_comparable_to",
      "is_strictly_comparable_to",
      "is_strictly_comparable_to",
      "magnitude",
      "add",
    ],
    "lower-kebab": [
      "is-strictly-comparable-to",
      "is-strictly-comparable-to",
      "is-strictly-comparable-to",
      "is-strictly-comparable-to",
      "magnitude",
      "add",
    ],
    "Upper-Kebab": [
      "Is-Strictly-Comparable-To",
      "Is-Strictly-Comparable-To",
      "Is-Strictly-Comparable-To",
      "Is-Strictly-Comparable-To",
      "Magnitude",
      "Add",
    ],
    lowerCamel: [
      "isStrictlyComparableTo",
      "isStrictlyComparableTo",
      "isStrictlyComparableTo",
      "isStrictlyComparableTo",
      "magnitude",
      "add",
    ],
    UpperPascal: [
      "IsStrictlyComparableTo",
      "IsStrictlyComparableTo",
      "IsStrictlyComparableTo",
      "IsStrictlyComparableTo",
      "Magnitude",
      "Add",
    ],
  };

  for (const c of Object.keys(expected) as Case[]) {
    for (let i = 0; i < SAMPLES.length; i++) {
      const sample = SAMPLES[i]!;
      const want = expected[c][i]!;
      it(`format(tokenize(${sample.in}), ${c}) === ${want}`, () => {
        expect(format(tokenize(sample.in), c)).toBe(want);
      });
    }
  }

  it("renders empty token list as empty string", () => {
    expect(format([], "UpperPascal")).toBe("");
  });
});

describe("parseCaseName", () => {
  it("accepts canonical id-case values", () => {
    expect(parseCaseName("lower_snake", ALLOWED_ID_CASES)).toBe("lower_snake");
    expect(parseCaseName("lower-kebab", ALLOWED_ID_CASES)).toBe("lower-kebab");
  });
  it("accepts kebab aliases on id-case", () => {
    expect(parseCaseName("lower-hyphen", ALLOWED_ID_CASES)).toBe("lower-kebab");
    expect(parseCaseName("lower-dash", ALLOWED_ID_CASES)).toBe("lower-kebab");
  });
  it("rejects name-only cases on id-case", () => {
    expect(parseCaseName("UpperPascal", ALLOWED_ID_CASES)).toBeNull();
    expect(parseCaseName("lowerCamel", ALLOWED_ID_CASES)).toBeNull();
    expect(parseCaseName("Upper-Kebab", ALLOWED_ID_CASES)).toBeNull();
  });
  it("accepts all canonical name-case values", () => {
    expect(parseCaseName("lower_snake", ALLOWED_NAME_CASES)).toBe("lower_snake");
    expect(parseCaseName("lower-kebab", ALLOWED_NAME_CASES)).toBe("lower-kebab");
    expect(parseCaseName("Upper-Kebab", ALLOWED_NAME_CASES)).toBe("Upper-Kebab");
    expect(parseCaseName("lowerCamel", ALLOWED_NAME_CASES)).toBe("lowerCamel");
    expect(parseCaseName("UpperPascal", ALLOWED_NAME_CASES)).toBe("UpperPascal");
  });
  it("accepts every documented alias on name-case", () => {
    expect(parseCaseName("lower-hyphen", ALLOWED_NAME_CASES)).toBe("lower-kebab");
    expect(parseCaseName("lower-dash", ALLOWED_NAME_CASES)).toBe("lower-kebab");
    expect(parseCaseName("Upper-Hyphen", ALLOWED_NAME_CASES)).toBe("Upper-Kebab");
    expect(parseCaseName("Upper-Dash", ALLOWED_NAME_CASES)).toBe("Upper-Kebab");
    expect(parseCaseName("camel", ALLOWED_NAME_CASES)).toBe("lowerCamel");
    expect(parseCaseName("Pascal", ALLOWED_NAME_CASES)).toBe("UpperPascal");
  });
  it("is case-insensitive on the value", () => {
    expect(parseCaseName("LOWER_SNAKE", ALLOWED_NAME_CASES)).toBe("lower_snake");
    expect(parseCaseName("upperpascal", ALLOWED_NAME_CASES)).toBe("UpperPascal");
    expect(parseCaseName("UPPER-DASH", ALLOWED_NAME_CASES)).toBe("Upper-Kebab");
  });
  it("returns null for unknown values", () => {
    expect(parseCaseName("snake", ALLOWED_NAME_CASES)).toBeNull();
    expect(parseCaseName("", ALLOWED_NAME_CASES)).toBeNull();
    expect(parseCaseName("kebab", ALLOWED_NAME_CASES)).toBeNull();
  });
});
