import { describe, expect, it } from "bun:test";
import { parseArgv } from "./lib/argv.ts";
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

function ok(r: ReturnType<typeof parseArgv>): asserts r is Exclude<ReturnType<typeof parseArgv>, { error: string }> {
  if ('error' in r) throw new Error('expected ok, got: ' + r.error);
}
function err(r: ReturnType<typeof parseArgv>): asserts r is { error: string } {
  if (!('error' in r)) throw new Error('expected error, got ok');
}

describe('parseArgv', () => {
  it('rejects empty argv (nothing to do)', () => {
    const r = parseArgv([]);
    err(r);
    expect(r.error).toContain('nothing to do');
  });

  it('rejects --all-snake + --all-fhir', () => {
    const r = parseArgv(['--all-snake', '--all-fhir']);
    err(r);
    expect(r.error).toContain('mutually exclusive');
  });

  it('rejects --all-snake + --id-case', () => {
    const r = parseArgv(['--all-snake', '--id-case', 'lower-kebab']);
    err(r);
    expect(r.error).toContain('cannot be combined');
  });

  it('rejects --all-fhir + --name-case', () => {
    const r = parseArgv(['--all-fhir', '--name-case', 'lowerCamel']);
    err(r);
    expect(r.error).toContain('cannot be combined');
  });

  it('rejects --repair + --all-snake', () => {
    const r = parseArgv(['--repair', '--all-snake']);
    err(r);
    expect(r.error).toContain('--repair');
  });

  it('rejects --repair + --title-case', () => {
    const r = parseArgv(['--repair', '--title-case', 'lower_snake']);
    err(r);
    expect(r.error).toContain('--repair');
  });

  it('rejects unknown --id-case value', () => {
    const r = parseArgv(['--id-case', 'snake']);
    err(r);
    expect(r.error).toContain('--id-case');
  });

  it('rejects name-only case value on --id-case', () => {
    const r = parseArgv(['--id-case', 'UpperPascal']);
    err(r);
    expect(r.error).toContain('--id-case');
  });

  it('rejects unknown --name-case value', () => {
    const r = parseArgv(['--name-case', 'kebab']);
    err(r);
    expect(r.error).toContain('--name-case');
  });

  it('rejects unknown --title-case value', () => {
    const r = parseArgv(['--title-case', 'spongebob']);
    err(r);
    expect(r.error).toContain('--title-case');
  });

  it('rejects unknown flag', () => {
    const r = parseArgv(['--bogus']);
    err(r);
    expect(r.error).toMatch(/error:/);
  });

  it('expands --all-snake to all-snake fields', () => {
    const r = parseArgv(['--all-snake']);
    ok(r);
    expect(r.idCase).toBe('lower_snake');
    expect(r.nameCase).toBe('lower_snake');
    expect(r.titleCase).toBe('lower_snake');
    expect(r.repair).toBe(false);
    expect(r.dryRun).toBe(false);
  });

  it('expands --all-fhir to FHIR-flavored fields', () => {
    const r = parseArgv(['--all-fhir']);
    ok(r);
    expect(r.idCase).toBe('lower-kebab');
    expect(r.nameCase).toBe('UpperPascal');
    expect(r.titleCase).toBe('UpperPascal');
  });

  it('resolves --id-case lower-hyphen to lower-kebab', () => {
    const r = parseArgv(['--id-case', 'lower-hyphen']);
    ok(r);
    expect(r.idCase).toBe('lower-kebab');
  });

  it('resolves --id-case lower-dash to lower-kebab', () => {
    const r = parseArgv(['--id-case', 'lower-dash']);
    ok(r);
    expect(r.idCase).toBe('lower-kebab');
  });

  it('mix-and-match per-field flags work together', () => {
    const r = parseArgv([
      '--id-case', 'lower-kebab',
      '--name-case', 'UpperPascal',
      '--title-case', 'lower_snake',
    ]);
    ok(r);
    expect(r.idCase).toBe('lower-kebab');
    expect(r.nameCase).toBe('UpperPascal');
    expect(r.titleCase).toBe('lower_snake');
  });

  it('--dry-run combines with --all-snake', () => {
    const r = parseArgv(['--all-snake', '--dry-run']);
    ok(r);
    expect(r.dryRun).toBe(true);
  });

  it('--dry-run combines with --repair', () => {
    const r = parseArgv(['--repair', '--dry-run']);
    ok(r);
    expect(r.dryRun).toBe(true);
    expect(r.repair).toBe(true);
  });

  it('--dry-run combines with mix-and-match', () => {
    const r = parseArgv(['--id-case', 'lower_snake', '--dry-run']);
    ok(r);
    expect(r.dryRun).toBe(true);
    expect(r.idCase).toBe('lower_snake');
  });

  it('--repair alone parses as repair mode', () => {
    const r = parseArgv(['--repair']);
    ok(r);
    expect(r.repair).toBe(true);
    expect(r.idCase).toBeNull();
    expect(r.nameCase).toBeNull();
    expect(r.titleCase).toBeNull();
  });

  it('--help short-circuits everything else', () => {
    const r = parseArgv(['--help']);
    ok(r);
    expect(r.help).toBe(true);
  });
});
