import { describe, expect, it } from "bun:test";
import { applyEdits, parseTree } from "jsonc-parser";
import { parseArgv } from "./lib/argv.ts";
import { planCaseChanges } from "./lib/edits.ts";
import { planRepair, resolveRefByTokens } from "./lib/repair.ts";
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

// CRLF fixture in IG-publisher style (single space around `:`, 2-space
// indent, no trailing newline). Constructed in-memory so it survives
// git's autocrlf shenanigans on Windows.
function crlf(lines: string[]): string {
  return lines.join('\r\n');
}

const FIXTURE_WITH_TITLE = crlf([
  '{',
  '  "resourceType" : "StructureDefinition",',
  '  "id" : "DV-DATE",',
  '  "contained" : [{',
  '    "resourceType" : "OperationDefinition",',
  '    "id" : "is-strictly-comparable-to",',
  '    "name" : "IsStrictlyComparableTo",',
  '    "title" : "is_strictly_comparable_to",',
  '    "code" : "is_strictly_comparable_to"',
  '  },',
  '  {',
  '    "resourceType" : "OperationDefinition",',
  '    "id" : "magnitude",',
  '    "name" : "magnitude",',
  '    "title" : "magnitude",',
  '    "code" : "magnitude"',
  '  }],',
  '  "extension" : [{',
  '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
  '    "valueCanonical" : "#is-strictly-comparable-to"',
  '  },',
  '  {',
  '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
  '    "valueCanonical" : "#magnitude"',
  '  }]',
  '}',
]);

function plan(source: string, args: { idCase?: any; nameCase?: any; titleCase?: any }) {
  const root = parseTree(source);
  if (!root) throw new Error('parse failed');
  return planCaseChanges({
    source,
    root,
    idCase: args.idCase ?? null,
    nameCase: args.nameCase ?? null,
    titleCase: args.titleCase ?? null,
  });
}

describe('planCaseChanges', () => {
  it('--all-snake on FIXTURE_WITH_TITLE produces id+name+valueCanonical edits', () => {
    const r = plan(FIXTURE_WITH_TITLE, { idCase: 'lower_snake', nameCase: 'lower_snake', titleCase: 'lower_snake' });
    expect(r.errors).toEqual([]);
    // OpDef1 (was kebab id, Pascal name, snake title) -> id+name change.
    // OpDef2 (magnitude) is single-token, no string changes.
    // The kebab #ref to OpDef1 is rewritten to #snake.
    const fields = r.records.map((x) => `${x.opId}.${x.field}`).sort();
    expect(fields).toEqual([
      'is-strictly-comparable-to.id',
      'is-strictly-comparable-to.name',
      'is_strictly_comparable_to.valueCanonical',
    ]);
    const out = applyEdits(FIXTURE_WITH_TITLE, r.edits);
    expect(out).toContain('"id" : "is_strictly_comparable_to"');
    expect(out).toContain('"name" : "is_strictly_comparable_to"');
    expect(out).toContain('"valueCanonical" : "#is_strictly_comparable_to"');
    expect(out).toContain('"valueCanonical" : "#magnitude"');
  });

  it('--all-fhir on FIXTURE_WITH_TITLE only flips name/title (id+ext already kebab)', () => {
    const r = plan(FIXTURE_WITH_TITLE, { idCase: 'lower-kebab', nameCase: 'UpperPascal', titleCase: 'UpperPascal' });
    expect(r.errors).toEqual([]);
    const out = applyEdits(FIXTURE_WITH_TITLE, r.edits);
    // OpDef1: id stays kebab (lower-kebab); name already Pascal; title flips snake->Pascal.
    expect(out).toContain('"id" : "is-strictly-comparable-to"');
    expect(out).toContain('"name" : "IsStrictlyComparableTo"');
    expect(out).toContain('"title" : "IsStrictlyComparableTo"');
    // OpDef2: magnitude (single token) gets Pascal name+title.
    expect(out).toContain('"name" : "Magnitude"');
    expect(out).toContain('"title" : "Magnitude"');
    // No rewrites needed for the ext frags (already kebab/single-token).
    expect(out).toContain('"valueCanonical" : "#is-strictly-comparable-to"');
    expect(out).toContain('"valueCanonical" : "#magnitude"');
  });

  it('preserves bytes outside planned edit ranges (CRLF, indentation, separator)', () => {
    const r = plan(FIXTURE_WITH_TITLE, { idCase: 'lower_snake', nameCase: 'lower_snake' });
    const out = applyEdits(FIXTURE_WITH_TITLE, r.edits);
    // Same number of CRLF tokens (we only swap string values)
    const crlfCount = (s: string) => (s.match(/\r\n/g) ?? []).length;
    expect(crlfCount(out)).toBe(crlfCount(FIXTURE_WITH_TITLE));
    // Same trailing byte
    expect(out.charCodeAt(out.length - 1)).toBe(FIXTURE_WITH_TITLE.charCodeAt(FIXTURE_WITH_TITLE.length - 1));
    // Same separator style preserved
    expect(out).toContain('"id" : "is_strictly_comparable_to"');
  });

  it('is idempotent: re-planning on the output yields zero edits and zero records', () => {
    const r1 = plan(FIXTURE_WITH_TITLE, { idCase: 'lower_snake', nameCase: 'lower_snake', titleCase: 'lower_snake' });
    const out = applyEdits(FIXTURE_WITH_TITLE, r1.edits);
    const r2 = plan(out, { idCase: 'lower_snake', nameCase: 'lower_snake', titleCase: 'lower_snake' });
    expect(r2.edits).toEqual([]);
    expect(r2.records).toEqual([]);
    expect(r2.errors).toEqual([]);
  });

  it('inserts a missing title with matching CRLF + 4-space indent (after name)', () => {
    const fixtureNoTitle = crlf([
      '{',
      '  "contained" : [{',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "magnitude",',
      '    "name" : "magnitude",',
      '    "code" : "magnitude"',
      '  }]',
      '}',
    ]);
    const r = plan(fixtureNoTitle, { titleCase: 'lower_snake' });
    expect(r.errors).toEqual([]);
    expect(r.records).toEqual([
      { opId: 'magnitude', field: 'title', oldValue: null, newValue: 'magnitude' },
    ]);
    const out = applyEdits(fixtureNoTitle, r.edits);
    // Inserted after "name", before "code", with CRLF + 4-space indent and " : " separator.
    expect(out).toContain('"name" : "magnitude",\r\n    "title" : "magnitude",\r\n    "code"');
  });

  it('inserts a missing title using LF EOL when the host file is LF', () => {
    const fixtureLf =
      '{\n' +
      '  "contained" : [{\n' +
      '    "resourceType" : "OperationDefinition",\n' +
      '    "id" : "magnitude",\n' +
      '    "name" : "magnitude",\n' +
      '    "code" : "magnitude"\n' +
      '  }]\n' +
      '}';
    const r = plan(fixtureLf, { titleCase: 'lower_snake' });
    expect(r.errors).toEqual([]);
    const out = applyEdits(fixtureLf, r.edits);
    expect(out).toContain('"name" : "magnitude",\n    "title" : "magnitude",\n    "code"');
    expect(out).not.toContain('\r');
  });

  it('detects duplicate ids after re-casing', () => {
    const dup = crlf([
      '{',
      '  "contained" : [{',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "magnitude",',
      '    "name" : "magnitude",',
      '    "code" : "magnitude"',
      '  },',
      '  {',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "Magnitude",',
      '    "name" : "Magnitude",',
      '    "code" : "magnitude"',
      '  }]',
      '}',
    ]);
    const r = plan(dup, { idCase: 'lower_snake', nameCase: 'lower_snake' });
    expect(r.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it('detects unresolved valueCanonical fragments (case-changing mode)', () => {
    const broken = crlf([
      '{',
      '  "contained" : [{',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "magnitude",',
      '    "name" : "magnitude",',
      '    "code" : "magnitude"',
      '  }],',
      '  "extension" : [{',
      '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
      '    "valueCanonical" : "#nonexistent_function"',
      '  }]',
      '}',
    ]);
    const r = plan(broken, { idCase: 'lower_snake' });
    expect(r.errors.some((e) => e.includes("does not resolve"))).toBe(true);
  });

  it('skips absolute-URL valueCanonical refs silently', () => {
    const absolute = crlf([
      '{',
      '  "contained" : [{',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "magnitude",',
      '    "name" : "magnitude",',
      '    "code" : "magnitude"',
      '  }],',
      '  "extension" : [{',
      '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
      '    "valueCanonical" : "http://example.org/other#magnitude"',
      '  }]',
      '}',
    ]);
    const r = plan(absolute, { idCase: 'lower_snake' });
    expect(r.errors).toEqual([]);
  });
});

describe('resolveRefByTokens', () => {
  it('exact-token match returns the matching id', () => {
    const r = resolveRefByTokens('is_strictly_comparable_to', [
      'is-strictly-comparable-to',
      'magnitude',
    ]);
    expect(r).toEqual({ kind: 'match', id: 'is-strictly-comparable-to' });
  });

  it('returns none when no id has the same token sequence', () => {
    const r = resolveRefByTokens('typo_func', ['magnitude', 'add']);
    expect(r.kind).toBe('none');
  });

  it('returns ambiguous when multiple ids share the token sequence', () => {
    const r = resolveRefByTokens('foo_bar', ['foo-bar', 'fooBar']);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.ids.sort()).toEqual(['foo-bar', 'fooBar'].sort());
    }
  });
});

describe('planRepair', () => {
  it('rewrites #snake fragment to match a kebab id', () => {
    const broken = crlf([
      '{',
      '  "contained" : [{',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "is-strictly-comparable-to",',
      '    "code" : "is_strictly_comparable_to"',
      '  }],',
      '  "extension" : [{',
      '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
      '    "valueCanonical" : "#is_strictly_comparable_to"',
      '  }]',
      '}',
    ]);
    const root = parseTree(broken)!;
    const r = planRepair({ source: broken, root });
    expect(r.errors).toEqual([]);
    expect(r.records).toEqual([
      {
        opId: 'is-strictly-comparable-to',
        field: 'valueCanonical',
        oldValue: '#is_strictly_comparable_to',
        newValue: '#is-strictly-comparable-to',
      },
    ]);
    const out = applyEdits(broken, r.edits);
    expect(out).toContain('"valueCanonical" : "#is-strictly-comparable-to"');
  });

  it('emits zero edits when all fragments already match', () => {
    const aligned = crlf([
      '{',
      '  "contained" : [{',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "magnitude",',
      '    "code" : "magnitude"',
      '  }],',
      '  "extension" : [{',
      '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
      '    "valueCanonical" : "#magnitude"',
      '  }]',
      '}',
    ]);
    const root = parseTree(aligned)!;
    const r = planRepair({ source: aligned, root });
    expect(r.errors).toEqual([]);
    expect(r.edits).toEqual([]);
    expect(r.records).toEqual([]);
  });

  it('errors on a fragment that resolves to no OpDef', () => {
    const broken = crlf([
      '{',
      '  "contained" : [{',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "magnitude",',
      '    "code" : "magnitude"',
      '  }],',
      '  "extension" : [{',
      '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
      '    "valueCanonical" : "#typo_func"',
      '  }]',
      '}',
    ]);
    const root = parseTree(broken)!;
    const r = planRepair({ source: broken, root });
    expect(r.errors.some((e) => e.includes('does not resolve'))).toBe(true);
    expect(r.edits).toEqual([]);
  });

  it('errors (and writes nothing) when a fragment is ambiguous', () => {
    const ambiguous = crlf([
      '{',
      '  "contained" : [{',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "foo-bar",',
      '    "code" : "foo_bar"',
      '  },',
      '  {',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "fooBar",',
      '    "code" : "foo_bar"',
      '  }],',
      '  "extension" : [{',
      '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
      '    "valueCanonical" : "#foo_bar"',
      '  }]',
      '}',
    ]);
    const root = parseTree(ambiguous)!;
    const r = planRepair({ source: ambiguous, root });
    expect(r.errors.some((e) => e.includes('ambiguous'))).toBe(true);
    expect(r.edits).toEqual([]);
  });
});
