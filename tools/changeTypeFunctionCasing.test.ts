import { describe, expect, it } from "bun:test";
import { applyEdits, parseTree } from "jsonc-parser";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preservesTrailingByte,
  runWith,
} from "./changeTypeFunctionCasing.ts";
import { parseArgv } from "./lib/argv.ts";
import { planCaseChanges } from "./lib/edits.ts";
import { planRepair, resolveRefByTokens } from "./lib/repair.ts";
import {
  ALLOWED_CASES,
  type Case,
  format,
  parseCaseName,
  tokenize,
} from "./lib/casing.ts";
import {
  discoverSdCanonicals,
  isPinnedSdFile,
  isStructureDefinitionRoot,
  PINNED_SD_CANONICALS,
  planSdCanonicalRewrite,
  resolveDivergentType,
  type SdLookupIndex,
} from "./lib/sdCanonical.ts";

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
    Title_Snake: [
      "Is_Strictly_Comparable_To",
      "Is_Strictly_Comparable_To",
      "Is_Strictly_Comparable_To",
      "Is_Strictly_Comparable_To",
      "Magnitude",
      "Add",
    ],
    "Title-Kebab": [
      "Is-Strictly-Comparable-To",
      "Is-Strictly-Comparable-To",
      "Is-Strictly-Comparable-To",
      "Is-Strictly-Comparable-To",
      "Magnitude",
      "Add",
    ],
    UPPER_SNAKE: [
      "IS_STRICTLY_COMPARABLE_TO",
      "IS_STRICTLY_COMPARABLE_TO",
      "IS_STRICTLY_COMPARABLE_TO",
      "IS_STRICTLY_COMPARABLE_TO",
      "MAGNITUDE",
      "ADD",
    ],
    "UPPER-KEBAB": [
      "IS-STRICTLY-COMPARABLE-TO",
      "IS-STRICTLY-COMPARABLE-TO",
      "IS-STRICTLY-COMPARABLE-TO",
      "IS-STRICTLY-COMPARABLE-TO",
      "MAGNITUDE",
      "ADD",
    ],
    camel: [
      "isStrictlyComparableTo",
      "isStrictlyComparableTo",
      "isStrictlyComparableTo",
      "isStrictlyComparableTo",
      "magnitude",
      "add",
    ],
    Pascal: [
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
    expect(format([], "Pascal")).toBe("");
  });

  it("UPPER-KEBAB renders fully upper-case with hyphens", () => {
    expect(format(["activity", "item", "structure"], "UPPER-KEBAB")).toBe(
      "ACTIVITY-ITEM-STRUCTURE",
    );
  });

  it("UPPER_SNAKE renders fully upper-case with underscores", () => {
    expect(format(["activity", "item", "structure"], "UPPER_SNAKE")).toBe(
      "ACTIVITY_ITEM_STRUCTURE",
    );
  });

  it("Title_Snake renders title-style with underscore separators", () => {
    expect(format(["activity", "item", "structure"], "Title_Snake")).toBe(
      "Activity_Item_Structure",
    );
  });

  // Render-rule pin-downs: format normalizes per-token (lowercase
  // then shape). All-caps input tokens are NOT preserved -- this
  // documents the deliberate deviation from the source request's
  // "preserve all-caps token runs" rule (see plan.md Open Questions).
  it("Pascal: all-caps input tokens are lowercased then capitalized (DV-EHR-URI -> DvEhrUri)", () => {
    expect(format(["DV", "EHR", "URI"], "Pascal")).toBe("DvEhrUri");
  });

  it("Title-Kebab: all-caps input tokens are lowercased then capitalized (DV-EHR-URI -> Dv-Ehr-Uri)", () => {
    expect(format(["DV", "EHR", "URI"], "Title-Kebab")).toBe("Dv-Ehr-Uri");
  });

  it("camel: all-caps input tokens are lowercased then capitalized (EHR-ACCESS -> ehrAccess)", () => {
    expect(format(["EHR", "ACCESS"], "camel")).toBe("ehrAccess");
  });
});

describe("parseCaseName", () => {
  it("accepts every canonical case name (round-trips to itself)", () => {
    expect(parseCaseName("lower_snake")).toBe("lower_snake");
    expect(parseCaseName("lower-kebab")).toBe("lower-kebab");
    expect(parseCaseName("Title_Snake")).toBe("Title_Snake");
    expect(parseCaseName("Title-Kebab")).toBe("Title-Kebab");
    expect(parseCaseName("UPPER_SNAKE")).toBe("UPPER_SNAKE");
    expect(parseCaseName("UPPER-KEBAB")).toBe("UPPER-KEBAB");
    expect(parseCaseName("camel")).toBe("camel");
    expect(parseCaseName("Pascal")).toBe("Pascal");
  });

  it("is case-insensitive on the value (family keyword sets the canonical)", () => {
    expect(parseCaseName("LOWER-KEBAB")).toBe("lower-kebab");
    expect(parseCaseName("Lower-Kebab")).toBe("lower-kebab");
    expect(parseCaseName("upper_snake")).toBe("UPPER_SNAKE");
    expect(parseCaseName("title-kebab")).toBe("Title-Kebab");
    expect(parseCaseName("TITLE_SNAKE")).toBe("Title_Snake");
    expect(parseCaseName("LoWeR_SnAkE")).toBe("lower_snake");
  });

  it("treats '-' and '_' as interchangeable separators", () => {
    expect(parseCaseName("lower_kebab")).toBe("lower-kebab");
    expect(parseCaseName("UPPER_KEBAB")).toBe("UPPER-KEBAB");
    expect(parseCaseName("upper-snake")).toBe("UPPER_SNAKE");
    expect(parseCaseName("Title_Kebab")).toBe("Title-Kebab");
    expect(parseCaseName("title-snake")).toBe("Title_Snake");
  });

  it("treats `pascal` family keyword as a synonym for `title`", () => {
    expect(parseCaseName("pascal_snake")).toBe("Title_Snake");
    expect(parseCaseName("pascal-kebab")).toBe("Title-Kebab");
    expect(parseCaseName("PASCAL-KEBAB")).toBe("Title-Kebab");
    expect(parseCaseName("pascal_kebab")).toBe("Title-Kebab");
  });

  it("single-token: Pascal/camel selection follows first-character casing", () => {
    expect(parseCaseName("Pascal")).toBe("Pascal");
    expect(parseCaseName("camel")).toBe("camel");
    // Counterintuitive (but documented) caveats:
    expect(parseCaseName("pascal")).toBe("camel");
    expect(parseCaseName("CAMEL")).toBe("Pascal");
  });

  it("rejects malformed input", () => {
    expect(parseCaseName("")).toBeNull();
    expect(parseCaseName("snake")).toBeNull();
    expect(parseCaseName("kebab")).toBeNull();
    expect(parseCaseName("title")).toBeNull();
    expect(parseCaseName("upper")).toBeNull();
    expect(parseCaseName("lower")).toBeNull();
    expect(parseCaseName("title_octopus")).toBeNull();
    expect(parseCaseName("weird_thing")).toBeNull();
    expect(parseCaseName("a_b_c")).toBeNull();
    expect(parseCaseName("title-")).toBeNull();
    expect(parseCaseName("-snake")).toBeNull();
    expect(parseCaseName("__")).toBeNull();
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

  it('rejects unknown --operation-id value', () => {
    const r = parseArgv(['--operation-id', 'snake']);
    err(r);
    expect(r.error).toContain('--operation-id');
  });

  it('rejects unknown --operation-name value', () => {
    const r = parseArgv(['--operation-name', 'kebab']);
    err(r);
    expect(r.error).toContain('--operation-name');
  });

  it('rejects unknown --operation-title value', () => {
    const r = parseArgv(['--operation-title', 'spongebob']);
    err(r);
    expect(r.error).toContain('--operation-title');
  });

  it('error messages list the unified 8-name allowlist', () => {
    const r = parseArgv(['--operation-name', 'spongebob']);
    err(r);
    expect(r.error).toContain('lower_snake');
    expect(r.error).toContain('UPPER_SNAKE');
    expect(r.error).toContain('camel');
    expect(r.error).toContain('Pascal');
  });

  it('rejects unknown flag', () => {
    const r = parseArgv(['--bogus']);
    err(r);
    expect(r.error).toMatch(/error:/);
  });

  it('mix-and-match per-field flags work together', () => {
    const r = parseArgv([
      '--operation-id', 'lower-kebab',
      '--operation-name', 'Pascal',
      '--operation-title', 'lower_snake',
    ]);
    ok(r);
    expect(r.operationIdCase).toBe('lower-kebab');
    expect(r.operationNameCase).toBe('Pascal');
    expect(r.operationTitleCase).toBe('lower_snake');
    expect(r.update).toBe(false);
  });

  it('--update combines with operation flags', () => {
    const r = parseArgv(['--operation-id', 'lower_snake', '--update']);
    ok(r);
    expect(r.update).toBe(true);
    expect(r.operationIdCase).toBe('lower_snake');
  });

  it('-u short alias for --update', () => {
    const r = parseArgv(['--operation-id', 'lower_snake', '-u']);
    ok(r);
    expect(r.update).toBe(true);
  });

  it('--update without any matrix flag is rejected', () => {
    const r = parseArgv(['--update']);
    err(r);
    expect(r.error).toContain('nothing to do');
  });

  it('--help short-circuits everything else', () => {
    const r = parseArgv(['--help']);
    ok(r);
    expect(r.help).toBe(true);
  });

  it('-h short alias for --help', () => {
    const r = parseArgv(['-h']);
    ok(r);
    expect(r.help).toBe(true);
  });

  // Short-form (alias) folding
  it('--op-id is an alias for --operation-id', () => {
    const r = parseArgv(['--op-id', 'lower_snake']);
    ok(r);
    expect(r.operationIdCase).toBe('lower_snake');
  });

  it('--op-name is an alias for --operation-name', () => {
    const r = parseArgv(['--op-name', 'Pascal']);
    ok(r);
    expect(r.operationNameCase).toBe('Pascal');
  });

  it('--op-title is an alias for --operation-title', () => {
    const r = parseArgv(['--op-title', 'Title-Kebab']);
    ok(r);
    expect(r.operationTitleCase).toBe('Title-Kebab');
  });

  it('--sd-id is an alias for --structure-id', () => {
    const r = parseArgv(['--sd-id', 'lower-kebab']);
    ok(r);
    expect(r.structureIdCase).toBe('lower-kebab');
  });

  it('--sd-name is an alias for --structure-name', () => {
    const r = parseArgv(['--sd-name', 'Pascal']);
    ok(r);
    expect(r.structureNameCase).toBe('Pascal');
  });

  it('--sd-title is an alias for --structure-title', () => {
    const r = parseArgv(['--sd-title', 'Title-Kebab']);
    ok(r);
    expect(r.structureTitleCase).toBe('Title-Kebab');
  });

  it('--op-canonical is an alias for --operation-canonical', () => {
    const r = parseArgv(['--op-canonical', '#ref']);
    ok(r);
    expect(r.operationCanonicalRefSync).toBe(true);
  });

  it('--sd-canonical is an alias for --structure-canonical', () => {
    const r = parseArgv(['--sd-canonical', 'UPPER-KEBAB']);
    ok(r);
    expect(r.structureCanonicalCase).toBe('UPPER-KEBAB');
  });

  it('long-form takes precedence on alias collision (last-wins folding)', () => {
    const r = parseArgv([
      '--op-id', 'lower-kebab',
      '--operation-id', 'lower_snake',
    ]);
    ok(r);
    expect(r.operationIdCase).toBe('lower_snake');
  });

  // --operation-canonical sentinel parsing
  for (const sentinel of ['none', 'na', 'ref', '#', '#ref', 'NONE', 'Ref', 'NA']) {
    it(`--operation-canonical ${JSON.stringify(sentinel)} parses as ref-sync true`, () => {
      const r = parseArgv(['--operation-canonical', sentinel]);
      ok(r);
      expect(r.operationCanonicalRefSync).toBe(true);
    });
  }

  it('--operation-canonical with invalid value is rejected', () => {
    const r = parseArgv(['--operation-canonical', 'sync']);
    err(r);
    expect(r.error).toContain('--operation-canonical');
  });

  // SD-side flags
  it('--structure-id lower-kebab parses', () => {
    const r = parseArgv(['--structure-id', 'lower-kebab']);
    ok(r);
    expect(r.structureIdCase).toBe('lower-kebab');
  });

  it('--structure-canonical accepts SC values', () => {
    const r = parseArgv(['--structure-canonical', 'UPPER-KEBAB']);
    ok(r);
    expect(r.structureCanonicalCase).toBe('UPPER-KEBAB');
  });

  // Slot-03: every case-taking flag accepts the unified 8-name allowlist.
  // Flags previously restricted to a per-flag subset now accept the full set.
  it('--operation-id accepts UPPER_SNAKE (previously restricted to id-case subset)', () => {
    const r = parseArgv(['--operation-id', 'UPPER_SNAKE']);
    ok(r);
    expect(r.operationIdCase).toBe('UPPER_SNAKE');
  });

  it('--structure-id accepts Title_Snake', () => {
    const r = parseArgv(['--structure-id', 'Title_Snake']);
    ok(r);
    expect(r.structureIdCase).toBe('Title_Snake');
  });

  it('--operation-name accepts title_snake (parser disambiguates to Title_Snake)', () => {
    const r = parseArgv(['--operation-name', 'title_snake']);
    ok(r);
    expect(r.operationNameCase).toBe('Title_Snake');
  });

  it('--operation-name accepts PASCAL-KEBAB (pascal family resolves to Title-Kebab)', () => {
    const r = parseArgv(['--operation-name', 'PASCAL-KEBAB']);
    ok(r);
    expect(r.operationNameCase).toBe('Title-Kebab');
  });

  it('--structure-canonical camel parses (was previously restricted out)', () => {
    const r = parseArgv(['--structure-canonical', 'camel']);
    ok(r);
    expect(r.structureCanonicalCase).toBe('camel');
  });

  it('--structure-canonical Pascal parses (was previously restricted out)', () => {
    const r = parseArgv(['--structure-canonical', 'Pascal']);
    ok(r);
    expect(r.structureCanonicalCase).toBe('Pascal');
  });

  // Removed-flag hints
  it('--all-snake is removed (with hint)', () => {
    const r = parseArgv(['--all-snake']);
    err(r);
    expect(r.error).toContain('--all-snake');
    expect(r.error).toContain('removed');
  });

  it('--all-fhir is removed (with hint)', () => {
    const r = parseArgv(['--all-fhir']);
    err(r);
    expect(r.error).toContain('--all-fhir');
    expect(r.error).toContain('removed');
  });

  it('--id-case is removed (with rename hint)', () => {
    const r = parseArgv(['--id-case', 'lower_snake']);
    err(r);
    expect(r.error).toContain('--id-case');
    expect(r.error).toContain('--operation-id');
  });

  it('--name-case is removed (with rename hint)', () => {
    const r = parseArgv(['--name-case', 'Pascal']);
    err(r);
    expect(r.error).toContain('--name-case');
    expect(r.error).toContain('--operation-name');
  });

  it('--title-case is removed (with rename hint)', () => {
    const r = parseArgv(['--title-case', 'lower_snake']);
    err(r);
    expect(r.error).toContain('--title-case');
    expect(r.error).toContain('--operation-title');
  });

  it('--repair is removed (with replacement hint)', () => {
    const r = parseArgv(['--repair']);
    err(r);
    expect(r.error).toContain('--repair');
    expect(r.error).toContain('--operation-canonical');
  });

  it('--dry-run is removed (with replacement hint)', () => {
    const r = parseArgv(['--dry-run']);
    err(r);
    expect(r.error).toContain('--dry-run');
    expect(r.error).toContain('--update');
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

function plan(source: string, args: { idCase?: any; nameCase?: any; titleCase?: any; structureIdCase?: any; structureNameCase?: any; structureTitleCase?: any }) {
  const root = parseTree(source);
  if (!root) throw new Error('parse failed');
  return planCaseChanges({
    source,
    root,
    idCase: args.idCase ?? null,
    nameCase: args.nameCase ?? null,
    titleCase: args.titleCase ?? null,
    structureIdCase: args.structureIdCase ?? null,
    structureNameCase: args.structureNameCase ?? null,
    structureTitleCase: args.structureTitleCase ?? null,
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
    const r = plan(FIXTURE_WITH_TITLE, { idCase: 'lower-kebab', nameCase: 'Pascal', titleCase: 'Pascal' });
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

describe('preservesTrailingByte', () => {
  it('passes when last bytes match', () => {
    expect(preservesTrailingByte(0x7d, 0x7d)).toBe(true);
  });
  it('fails when last bytes differ', () => {
    expect(preservesTrailingByte(0x7d, 0x0a)).toBe(false);
  });
  it('treats undefined as -1', () => {
    expect(preservesTrailingByte(undefined, undefined)).toBe(true);
    expect(preservesTrailingByte(0x7d, undefined)).toBe(false);
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cttfc-'));
  return dir;
}

function writeFixture(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), Buffer.from(content, 'utf8'));
}

function captureRun(argv: string[], resourcesDir: string): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = runWith(argv, {
    resourcesDir,
    out: (s) => { out += s; },
    err: (s) => { err += s; },
  });
  return { code, out, err };
}

describe('SD field flags (planCaseChanges structureIdCase/etc)', () => {
  it('--structure-id mutates SD.id only, leaves contained OpDef alone', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "contained" : [{',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "magnitude",',
      '    "name" : "magnitude",',
      '    "code" : "magnitude"',
      '  }]',
      '}',
    ]);
    const r = plan(fixture, { structureIdCase: 'lower-kebab' } as any);
    expect(r.errors).toEqual([]);
    expect(r.records).toEqual([
      { opId: 'ACTIVITY', field: 'sd.id', oldValue: 'ACTIVITY', newValue: 'activity' },
    ]);
    const out = applyEdits(fixture, r.edits);
    expect(out).toContain('"id" : "activity"');
    // OpDef untouched (single-token magnitude renders as "magnitude" in any case anyway,
    // but SD-only flags should never even visit the OpDef).
    expect(out).toContain('"id" : "magnitude"');
  });

  it('--structure-name + --structure-title work; missing title is inserted', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY-ITEM-STRUCTURE",',
      '  "name" : "ACTIVITY-ITEM-STRUCTURE"',
      '}',
    ]);
    const r = plan(fixture, {
      structureNameCase: 'Pascal',
      structureTitleCase: 'Title-Kebab',
    } as any);
    expect(r.errors).toEqual([]);
    const fields = r.records.map((x) => `${x.opId}.${x.field}`).sort();
    expect(fields).toEqual([
      'ACTIVITY-ITEM-STRUCTURE.sd.name',
      'ACTIVITY-ITEM-STRUCTURE.sd.title',
    ]);
    const out = applyEdits(fixture, r.edits);
    expect(out).toContain('"name" : "ActivityItemStructure"');
    // Title was inserted after the existing name property, with matching CRLF + 2-space indent.
    expect(out).toContain('"name" : "ActivityItemStructure",\r\n  "title" : "Activity-Item-Structure"');
  });

  it('composes operation-side and structure-side flags in one pass', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "contained" : [{',
      '    "resourceType" : "OperationDefinition",',
      '    "id" : "less-than",',
      '    "name" : "LessThan",',
      '    "title" : "less_than",',
      '    "code" : "less_than"',
      '  }]',
      '}',
    ]);
    const r = plan(fixture, {
      idCase: 'lower_snake',
      structureIdCase: 'lower-kebab',
    } as any);
    expect(r.errors).toEqual([]);
    const fields = r.records.map((x) => `${x.opId}.${x.field}`).sort();
    expect(fields).toEqual(['ACTIVITY.sd.id', 'less-than.id']);
    const out = applyEdits(fixture, r.edits);
    expect(out).toContain('"id" : "activity"');
    expect(out).toContain('"id" : "less_than"');
  });

  it('non-SD root file is silently skipped by SD-side flags', () => {
    const codeSystem = crlf([
      '{',
      '  "resourceType" : "CodeSystem",',
      '  "id" : "MEDIA-TYPES",',
      '  "url" : "http://example.org/cs/MEDIA-TYPES"',
      '}',
    ]);
    const r = plan(codeSystem, {
      structureIdCase: 'lower-kebab',
      structureNameCase: 'Pascal',
      structureTitleCase: 'lower_snake',
    } as any);
    expect(r.errors).toEqual([]);
    expect(r.edits).toEqual([]);
    expect(r.records).toEqual([]);
  });

  it('SD with no usable id/name/title errors when SD-side cases are requested', () => {
    const noTokens = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "url" : "http://example.org/sd/foo"',
      '}',
    ]);
    const r = plan(noTokens, { structureIdCase: 'lower-kebab' } as any);
    expect(r.errors.some((e) => e.includes('no usable id/name/title'))).toBe(true);
  });
});

describe('runWith (end-to-end) > SD field flags', () => {
  it('--structure-id lower-kebab on a single-SD file updates only the SD.id', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'ACTIVITY.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "ACTIVITY",',
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "magnitude",',
        '    "name" : "magnitude",',
        '    "code" : "magnitude"',
        '  }]',
        '}',
      ]));
      const r = captureRun(['--structure-id', 'lower-kebab', '--update'], dir);
      expect(r.code).toBe(0);
      expect(r.out).toContain('ACTIVITY.id: "ACTIVITY" -> "activity"');
      const after = readFileSync(join(dir, 'ACTIVITY.json'), 'utf8');
      expect(after).toContain('"id" : "activity"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 4: --structure-canonical
// ---------------------------------------------------------------------------

describe('discoverSdCanonicals + isStructureDefinitionRoot', () => {
  it('isStructureDefinitionRoot returns true for SD roots only', () => {
    const sd = parseTree('{"resourceType":"StructureDefinition","url":"http://x/A"}')!;
    const cs = parseTree('{"resourceType":"CodeSystem","url":"http://x/cs/A"}')!;
    expect(isStructureDefinitionRoot(sd)).toBe(true);
    expect(isStructureDefinitionRoot(cs)).toBe(false);
  });

  it('discoverSdCanonicals collects every SD url, skips non-SDs', () => {
    const sd1 = parseTree('{"resourceType":"StructureDefinition","url":"http://x/A"}')!;
    const sd2 = parseTree('{"resourceType":"StructureDefinition","url":"http://x/B"}')!;
    const cs = parseTree('{"resourceType":"CodeSystem","url":"http://x/cs/C"}')!;
    const r = discoverSdCanonicals([
      { relPath: 'A.json', source: '', root: sd1 },
      { relPath: 'B.json', source: '', root: sd2 },
      { relPath: 'C.json', source: '', root: cs },
    ]);
    expect([...r.canonicals].sort()).toEqual(['http://x/A', 'http://x/B']);
  });

  it('discoverSdCanonicals builds a tokenize-keyed index keyed by url-last-segment AND id', () => {
    const sd1 = parseTree('{"resourceType":"StructureDefinition","id":"ADDRESSED-MESSAGE","url":"http://x/sd/ADDRESSED-MESSAGE"}')!;
    const sd2 = parseTree('{"resourceType":"StructureDefinition","id":"DV_TEXT","url":"http://x/sd/DvText"}')!;
    const r = discoverSdCanonicals([
      { relPath: 'A.json', source: '', root: sd1 },
      { relPath: 'B.json', source: '', root: sd2 },
    ]);
    // Token key for "ADDRESSED-MESSAGE" / "addressed_message" / "AddressedMessage"
    // is "addressed|message" (tokenize lowercases + joins on a delimiter that
    // cannot appear in a token).
    const sd1Bucket = r.index.get('addressed|message');
    expect(sd1Bucket).toBeDefined();
    expect(sd1Bucket!.length).toBe(1);
    expect(sd1Bucket![0]!.url).toBe('http://x/sd/ADDRESSED-MESSAGE');
    expect(sd1Bucket![0]!.id).toBe('ADDRESSED-MESSAGE');

    // SD2: id "DV_TEXT" tokenizes to "dv|text"; url last segment "DvText"
    // tokenizes to "dv|text" as well. Single SD must NOT appear twice in
    // the bucket (de-dup by url).
    const sd2Bucket = r.index.get('dv|text');
    expect(sd2Bucket).toBeDefined();
    expect(sd2Bucket!.length).toBe(1);
    expect(sd2Bucket![0]!.url).toBe('http://x/sd/DvText');
  });

  it('discoverSdCanonicals indexes id and url-segment under separate keys when they tokenize differently', () => {
    const sd = parseTree('{"resourceType":"StructureDefinition","id":"alias","url":"http://x/sd/RealName"}')!;
    const r = discoverSdCanonicals([
      { relPath: 'A.json', source: '', root: sd },
    ]);
    expect(r.index.get('alias')!.length).toBe(1);
    expect(r.index.get('real|name')!.length).toBe(1);
    expect(r.index.get('alias')![0]!.url).toBe('http://x/sd/RealName');
    expect(r.index.get('real|name')![0]!.url).toBe('http://x/sd/RealName');
  });
});

describe('resolveDivergentType', () => {
  function buildIndex(entries: Array<{ url: string; id?: string }>): SdLookupIndex {
    const inputs = entries.map((e, i) => {
      const idLine = e.id ? `"id":${JSON.stringify(e.id)},` : '';
      const root = parseTree(`{"resourceType":"StructureDefinition",${idLine}"url":${JSON.stringify(e.url)}}`)!;
      return { relPath: `f${i}.json`, source: '', root };
    });
    return discoverSdCanonicals(inputs).index;
  }

  it('exact tokenize match: separator-only difference', () => {
    const idx = buildIndex([{ url: 'http://x/sd/ADDRESSED-MESSAGE', id: 'ADDRESSED-MESSAGE' }]);
    const r = resolveDivergentType('http://other/sd/ADDRESSED_MESSAGE', idx);
    expect(r).toEqual({ kind: 'match', canonicalUrl: 'http://x/sd/ADDRESSED-MESSAGE' });
  });

  it('exact tokenize match: case-only difference', () => {
    const idx = buildIndex([{ url: 'http://x/sd/DV-TEXT', id: 'DV-TEXT' }]);
    const r = resolveDivergentType('http://x/sd/dv-text', idx);
    expect(r).toEqual({ kind: 'match', canonicalUrl: 'http://x/sd/DV-TEXT' });
  });

  it('bare-segment input matches by tokenization', () => {
    const idx = buildIndex([{ url: 'http://x/sd/ADDRESSED-MESSAGE', id: 'ADDRESSED-MESSAGE' }]);
    const r = resolveDivergentType('AddressedMessage', idx);
    expect(r).toEqual({ kind: 'match', canonicalUrl: 'http://x/sd/ADDRESSED-MESSAGE' });
  });

  it('id-only match (url last-segment differs from id)', () => {
    const idx = buildIndex([{ url: 'http://x/sd/Alpha', id: 'beta' }]);
    const r = resolveDivergentType('http://x/sd/BETA', idx);
    expect(r).toEqual({ kind: 'match', canonicalUrl: 'http://x/sd/Alpha' });
  });

  it('no-match returns kind:none', () => {
    const idx = buildIndex([{ url: 'http://x/sd/ALPHA', id: 'ALPHA' }]);
    const r = resolveDivergentType('http://x/sd/Mismatch', idx);
    expect(r).toEqual({ kind: 'none' });
  });

  it('empty input or empty token-key returns kind:none', () => {
    const idx = buildIndex([{ url: 'http://x/sd/ALPHA', id: 'ALPHA' }]);
    expect(resolveDivergentType('', idx)).toEqual({ kind: 'none' });
    expect(resolveDivergentType('___', idx)).toEqual({ kind: 'none' });
  });

  it('ambiguous: two distinct SDs share the same tokenized name', () => {
    const idx = buildIndex([
      { url: 'http://a.example.org/sd/FOO-BAR', id: 'FOO-BAR' },
      { url: 'http://b.example.org/sd/foo_bar', id: 'foo_bar' },
    ]);
    const r = resolveDivergentType('FooBar', idx);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates).toEqual([
        'http://a.example.org/sd/FOO-BAR',
        'http://b.example.org/sd/foo_bar',
      ]);
    }
  });

  it('single SD whose id and url-segment tokenize identically is NOT counted as ambiguous', () => {
    // Common case in input/resources/: id == url-last-segment.
    const idx = buildIndex([{ url: 'http://x/sd/ADDRESSED-MESSAGE', id: 'ADDRESSED-MESSAGE' }]);
    const r = resolveDivergentType('http://x/sd/ADDRESSED_MESSAGE', idx);
    expect(r).toEqual({ kind: 'match', canonicalUrl: 'http://x/sd/ADDRESSED-MESSAGE' });
  });
});

function planSC(source: string, targetCase: Case, discovered: Set<string>) {
  const root = parseTree(source);
  if (!root) throw new Error('parse failed');
  return planSdCanonicalRewrite({ source, root, targetCase, discovered });
}

describe('planSdCanonicalRewrite', () => {
  it('per-trio: rewrites url, type, baseDefinition final segments only', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "url" : "http://example.org/sd/ACTIVITY",',
      '  "type" : "http://example.org/sd/ACTIVITY",',
      '  "baseDefinition" : "http://example.org/sd/LOCATABLE"',
      '}',
    ]);
    const discovered = new Set([
      'http://example.org/sd/ACTIVITY',
      'http://example.org/sd/LOCATABLE',
    ]);
    const r = planSC(fixture, 'lower_snake', discovered);
    expect(r.errors).toEqual([]);
    expect(r.records.length).toBe(3);
    const fields = r.records.map((x) => x.field).sort();
    expect(fields).toEqual(['sd.baseDefinition', 'sd.type', 'sd.url']);
    const out = applyEdits(fixture, r.edits);
    expect(out).toContain('"url" : "http://example.org/sd/activity"');
    expect(out).toContain('"type" : "http://example.org/sd/activity"');
    expect(out).toContain('"baseDefinition" : "http://example.org/sd/locatable"');
  });

  it('rewrites cross-refs at code, profile[i], targetProfile[i], valueCanonical, valueUrl', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "url" : "http://example.org/sd/ACTIVITY",',
      '  "extension" : [{',
      '    "url" : "http://example.org/ext/related",',
      '    "valueUrl" : "http://example.org/sd/EVENT"',
      '  }],',
      '  "differential" : {',
      '    "element" : [{',
      '      "type" : [{',
      '        "code" : "http://example.org/sd/EVENT",',
      '        "profile" : ["http://example.org/sd/ACTIVITY"],',
      '        "extension" : [{',
      '          "url" : "http://example.org/ext/x",',
      '          "valueCanonical" : "http://example.org/sd/EVENT"',
      '        }]',
      '      }]',
      '    },',
      '    {',
      '      "type" : [{',
      '        "code" : "Element",',
      '        "targetProfile" : ["http://example.org/sd/ACTIVITY"]',
      '      }]',
      '    }]',
      '  }',
      '}',
    ]);
    const discovered = new Set([
      'http://example.org/sd/ACTIVITY',
      'http://example.org/sd/EVENT',
    ]);
    const r = planSC(fixture, 'lower_snake', discovered);
    expect(r.errors).toEqual([]);
    const out = applyEdits(fixture, r.edits);
    expect(out).toContain('"url" : "http://example.org/sd/activity"');
    expect(out).toContain('"valueUrl" : "http://example.org/sd/event"');
    expect(out).toContain('"code" : "http://example.org/sd/event"');
    expect(out).toContain('"profile" : ["http://example.org/sd/activity"]');
    expect(out).toContain('"valueCanonical" : "http://example.org/sd/event"');
    expect(out).toContain('"targetProfile" : ["http://example.org/sd/activity"]');
    // Element (bare FHIR type, not in discovered) untouched.
    expect(out).toContain('"code" : "Element"');
  });

  it('non-discovered references (HL7 base, foreign URLs) are untouched', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "url" : "http://example.org/sd/ACTIVITY",',
      '  "baseDefinition" : "http://hl7.org/fhir/StructureDefinition/Element",',
      '  "differential" : {',
      '    "element" : [{',
      '      "type" : [{ "code" : "Element" }]',
      '    }]',
      '  }',
      '}',
    ]);
    const discovered = new Set(['http://example.org/sd/ACTIVITY']);
    const r = planSC(fixture, 'lower_snake', discovered);
    expect(r.errors).toEqual([]);
    const out = applyEdits(fixture, r.edits);
    // Only the SD's own url is rewritten (type missing, baseDefinition is HL7).
    expect(out).toContain('"url" : "http://example.org/sd/activity"');
    expect(out).toContain('"baseDefinition" : "http://hl7.org/fhir/StructureDefinition/Element"');
    expect(out).toContain('"code" : "Element"');
  });

  it('non-rewrite-key strings (binding.valueSet, code.coding.system) are untouched even on collision', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "url" : "http://example.org/sd/ACTIVITY",',
      '  "differential" : {',
      '    "element" : [{',
      '      "binding" : {',
      '        "valueSet" : "http://example.org/sd/ACTIVITY"',
      '      }',
      '    },',
      '    {',
      '      "code" : { "coding" : [{ "system" : "http://example.org/sd/ACTIVITY" }] }',
      '    }]',
      '  }',
      '}',
    ]);
    const discovered = new Set(['http://example.org/sd/ACTIVITY']);
    const r = planSC(fixture, 'lower_snake', discovered);
    const out = applyEdits(fixture, r.edits);
    // SD's own url rewrites; valueSet (not in allowlist) and
    // code.coding.system (key is "system", not in allowlist) are untouched.
    expect(out).toContain('"url" : "http://example.org/sd/activity"');
    expect(out).toContain('"valueSet" : "http://example.org/sd/ACTIVITY"');
    expect(out).toContain('"system" : "http://example.org/sd/ACTIVITY"');
  });

  it('divergent url vs type → per-file error, zero edits', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "url" : "http://example.org/sd/ACTIVITY",',
      '  "type" : "http://example.org/sd/Activity-Old"',
      '}',
    ]);
    const discovered = new Set(['http://example.org/sd/ACTIVITY']);
    const r = planSC(fixture, 'lower_snake', discovered);
    expect(r.errors.some((e) => e.includes('url and type final segments differ'))).toBe(true);
    expect(r.edits).toEqual([]);
  });

  it('versioned canonicals (.../FOO|1.2.0) do not match exact membership; no edits', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "url" : "http://example.org/sd/ACTIVITY",',
      '  "differential" : {',
      '    "element" : [{',
      '      "type" : [{ "profile" : ["http://example.org/sd/ACTIVITY|1.2.0"] }]',
      '    }]',
      '  }',
      '}',
    ]);
    const discovered = new Set(['http://example.org/sd/ACTIVITY']);
    const r = planSC(fixture, 'lower_snake', discovered);
    expect(r.errors).toEqual([]);
    const out = applyEdits(fixture, r.edits);
    // Only the SD's own url is rewritten; the versioned profile is untouched.
    expect(out).toContain('"url" : "http://example.org/sd/activity"');
    expect(out).toContain('"profile" : ["http://example.org/sd/ACTIVITY|1.2.0"]');
  });

  it('idempotent: re-running on already-canonical state emits zero edits', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "url" : "http://example.org/sd/ACTIVITY",',
      '  "type" : "http://example.org/sd/ACTIVITY"',
      '}',
    ]);
    const discovered = new Set(['http://example.org/sd/ACTIVITY']);
    const r = planSC(fixture, 'UPPER-KEBAB', discovered);
    expect(r.errors).toEqual([]);
    expect(r.edits).toEqual([]);
  });

  it('foreign-prefix SD: re-cases its own url segment (no prefix gate, per request)', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "FOO",',
      '  "url" : "http://hl7.org/fhir/StructureDefinition/FOO"',
      '}',
    ]);
    const discovered = new Set(['http://hl7.org/fhir/StructureDefinition/FOO']);
    const r = planSC(fixture, 'lower_snake', discovered);
    expect(r.errors).toEqual([]);
    const out = applyEdits(fixture, r.edits);
    expect(out).toContain('"url" : "http://hl7.org/fhir/StructureDefinition/foo"');
  });
});

function planSCWithIndex(
  source: string,
  targetCase: Case,
  discovered: Set<string>,
  index: SdLookupIndex,
) {
  const root = parseTree(source);
  if (!root) throw new Error('parse failed');
  return planSdCanonicalRewrite({ source, root, targetCase, discovered, index });
}

describe('planSdCanonicalRewrite (divergent-type resolver via index)', () => {
  it('self-resolves ADDRESSED-MESSAGE-style divergence: type rewritten to url, both re-cased', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ADDRESSED-MESSAGE",',
      '  "url" : "http://openehr.org/fhir/StructureDefinition/ADDRESSED-MESSAGE",',
      '  "type" : "http://openehr.org/fhir/StructureDefinition/ADDRESSED_MESSAGE"',
      '}',
    ]);
    const discovered = new Set(['http://openehr.org/fhir/StructureDefinition/ADDRESSED-MESSAGE']);
    const indexFiles = [
      { relPath: 'ADDRESSED-MESSAGE.json', source: fixture, root: parseTree(fixture)! },
    ];
    const index = discoverSdCanonicals(indexFiles).index;
    const r = planSCWithIndex(fixture, 'lower_snake', discovered, index);
    expect(r.errors).toEqual([]);
    // Expect a sd.type-resolve record AND a sd.url re-case record.
    const fields = r.records.map((x) => x.field).sort();
    expect(fields).toEqual(['sd.type-resolve', 'sd.url']);
    const out = applyEdits(fixture, r.edits);
    expect(out).toContain('"url" : "http://openehr.org/fhir/StructureDefinition/addressed_message"');
    expect(out).toContain('"type" : "http://openehr.org/fhir/StructureDefinition/addressed_message"');
  });

  it('self-resolves separator-only divergence even when the target case equals the current url case', () => {
    // url is already kebab; targetCase is kebab. url emits no edit; type
    // is still rewritten by the resolver (resolved value equals url).
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "DV-TEXT",',
      '  "url" : "http://openehr.org/fhir/StructureDefinition/DV-TEXT",',
      '  "type" : "http://openehr.org/fhir/StructureDefinition/DV_TEXT"',
      '}',
    ]);
    const discovered = new Set(['http://openehr.org/fhir/StructureDefinition/DV-TEXT']);
    const index = discoverSdCanonicals([
      { relPath: 'DV-TEXT.json', source: fixture, root: parseTree(fixture)! },
    ]).index;
    const r = planSCWithIndex(fixture, 'UPPER-KEBAB', discovered, index);
    expect(r.errors).toEqual([]);
    const fields = r.records.map((x) => x.field).sort();
    expect(fields).toEqual(['sd.type-resolve']);
    const out = applyEdits(fixture, r.edits);
    expect(out).toContain('"url" : "http://openehr.org/fhir/StructureDefinition/DV-TEXT"');
    expect(out).toContain('"type" : "http://openehr.org/fhir/StructureDefinition/DV-TEXT"');
  });

  it('promotes a bare-segment divergent type to the matched SD full url', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ADDRESSED-MESSAGE",',
      '  "url" : "http://openehr.org/fhir/StructureDefinition/ADDRESSED-MESSAGE",',
      '  "type" : "ADDRESSED_MESSAGE"',
      '}',
    ]);
    const discovered = new Set(['http://openehr.org/fhir/StructureDefinition/ADDRESSED-MESSAGE']);
    const index = discoverSdCanonicals([
      { relPath: 'ADDRESSED-MESSAGE.json', source: fixture, root: parseTree(fixture)! },
    ]).index;
    const r = planSCWithIndex(fixture, 'lower-kebab', discovered, index);
    expect(r.errors).toEqual([]);
    const out = applyEdits(fixture, r.edits);
    // Bare segment is replaced by the full URL form (post-re-cased).
    expect(out).toContain('"type" : "http://openehr.org/fhir/StructureDefinition/addressed-message"');
    expect(out).toContain('"url" : "http://openehr.org/fhir/StructureDefinition/addressed-message"');
  });

  it('ambiguous divergent type: errors with the candidates listed; emits zero edits', () => {
    const fileA = '{"resourceType":"StructureDefinition","id":"FOO-BAR","url":"http://a.example.org/sd/FOO-BAR"}';
    const fileB = '{"resourceType":"StructureDefinition","id":"foo_bar","url":"http://b.example.org/sd/foo_bar"}';
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "CLIENT",',
      '  "url" : "http://c.example.org/sd/CLIENT",',
      '  "type" : "FooBar"',
      '}',
    ]);
    const discovered = new Set([
      'http://a.example.org/sd/FOO-BAR',
      'http://b.example.org/sd/foo_bar',
      'http://c.example.org/sd/CLIENT',
    ]);
    const index = discoverSdCanonicals([
      { relPath: 'a.json', source: fileA, root: parseTree(fileA)! },
      { relPath: 'b.json', source: fileB, root: parseTree(fileB)! },
      { relPath: 'c.json', source: fixture, root: parseTree(fixture)! },
    ]).index;
    const r = planSCWithIndex(fixture, 'lower_snake', discovered, index);
    expect(r.edits).toEqual([]);
    expect(r.records).toEqual([]);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!).toContain("type 'FooBar' is ambiguous");
    expect(r.errors[0]!).toContain('http://a.example.org/sd/FOO-BAR');
    expect(r.errors[0]!).toContain('http://b.example.org/sd/foo_bar');
  });

  it('no-match divergent type with index: still falls back to the legacy "refusing to re-case" error', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "url" : "http://example.org/sd/ACTIVITY",',
      '  "type" : "http://example.org/sd/ENTIRELY-UNKNOWN"',
      '}',
    ]);
    const discovered = new Set(['http://example.org/sd/ACTIVITY']);
    const index = discoverSdCanonicals([
      { relPath: 'a.json', source: fixture, root: parseTree(fixture)! },
    ]).index;
    const r = planSCWithIndex(fixture, 'lower_snake', discovered, index);
    expect(r.edits).toEqual([]);
    expect(r.errors.some((e) => e.includes('url and type final segments differ'))).toBe(true);
  });

  it('non-divergent input: resolver does not fire (no sd.type-resolve record emitted)', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "url" : "http://example.org/sd/ACTIVITY",',
      '  "type" : "http://example.org/sd/ACTIVITY"',
      '}',
    ]);
    const discovered = new Set(['http://example.org/sd/ACTIVITY']);
    const index = discoverSdCanonicals([
      { relPath: 'a.json', source: fixture, root: parseTree(fixture)! },
    ]).index;
    const r = planSCWithIndex(fixture, 'lower_snake', discovered, index);
    expect(r.errors).toEqual([]);
    const fields = r.records.map((x) => x.field).sort();
    expect(fields).toEqual(['sd.type', 'sd.url']);
  });
});

describe('PINNED_SD_CANONICALS', () => {
  it('contains the openEHR `Any` canonical', () => {
    // Membership-only: deliberately no size assertion. When the set
    // legitimately graduates to a second SD, that contributor should
    // not also have to update an unrelated test.
    expect(
      PINNED_SD_CANONICALS.has('http://openehr.org/fhir/StructureDefinition/Any'),
    ).toBe(true);
  });
});

describe('isPinnedSdFile', () => {
  it('SD root with pinned url returns true', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "Any",',
      '  "url" : "http://openehr.org/fhir/StructureDefinition/Any"',
      '}',
    ]);
    const root = parseTree(fixture)!;
    expect(isPinnedSdFile(root)).toBe(true);
  });

  it('SD root with non-pinned url returns false', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "ACTIVITY",',
      '  "url" : "http://openehr.org/fhir/StructureDefinition/ACTIVITY"',
      '}',
    ]);
    const root = parseTree(fixture)!;
    expect(isPinnedSdFile(root)).toBe(false);
  });

  it('non-SD root with pinned url string returns false', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "CodeSystem",',
      '  "url" : "http://openehr.org/fhir/StructureDefinition/Any"',
      '}',
    ]);
    const root = parseTree(fixture)!;
    expect(isPinnedSdFile(root)).toBe(false);
  });
});

describe('planSdCanonicalRewrite (pinned SD)', () => {
  const PINNED_ANY = 'http://openehr.org/fhir/StructureDefinition/Any';

  for (const c of ALLOWED_CASES) {
    it(`pinned SD root produces zero edits/records/errors under targetCase ${c}`, () => {
      const fixture = crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "Any",',
        '  "name" : "Any",',
        '  "title" : "Any",',
        `  "url" : "${PINNED_ANY}",`,
        `  "type" : "${PINNED_ANY}",`,
        '  "baseDefinition" : "http://hl7.org/fhir/StructureDefinition/Base"',
        '}',
      ]);
      // Discovered set includes the pinned canonical (mirrors how
      // `discoverSdCanonicals` treats it: it IS in the discovered set;
      // the planner-level pin gate is what keeps it from being edited).
      const discovered = new Set([PINNED_ANY]);
      const r = planSC(fixture, c, discovered);
      expect(r.edits).toEqual([]);
      expect(r.records).toEqual([]);
      expect(r.errors).toEqual([]);
    });
  }

  it('cross-ref pin: sibling SD never re-cases references to Any but DOES re-case its own canonical trio', () => {
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "MESSAGE",',
      '  "url" : "http://openehr.org/fhir/StructureDefinition/MESSAGE",',
      '  "type" : "http://openehr.org/fhir/StructureDefinition/MESSAGE",',
      `  "baseDefinition" : "${PINNED_ANY}",`,
      '  "extension" : [',
      `    { "url" : "x", "valueCanonical" : "${PINNED_ANY}" },`,
      `    { "url" : "y", "valueUrl" : "${PINNED_ANY}" }`,
      '  ],',
      '  "differential" : {',
      '    "element" : [{',
      '      "type" : [{',
      `        "code" : "${PINNED_ANY}",`,
      `        "profile" : ["${PINNED_ANY}"],`,
      `        "targetProfile" : ["${PINNED_ANY}"]`,
      '      }, {',
      '        "code" : "http://example.org/sd/OTHER"',
      '      }]',
      '    }]',
      '  }',
      '}',
    ]);
    const discovered = new Set([
      PINNED_ANY,
      'http://example.org/sd/OTHER',
      'http://openehr.org/fhir/StructureDefinition/MESSAGE',
    ]);
    const r = planSC(fixture, 'lower_snake', discovered);
    expect(r.errors).toEqual([]);
    // Zero records whose newValue ends in `/any`.
    const anyHits = r.records.filter((x) => x.newValue.endsWith('/any'));
    expect(anyHits).toEqual([]);
    // Exactly one cross-ref record for OTHER.
    const otherHits = r.records.filter(
      (x) => x.newValue === 'http://example.org/sd/other',
    );
    expect(otherHits).toHaveLength(1);
    // MESSAGE's own url and type ARE re-cased (proves pin is per-canonical, not per-file).
    const sdUrlRec = r.records.find((x) => (x.field as string) === 'sd.url');
    expect(sdUrlRec?.newValue).toBe('http://openehr.org/fhir/StructureDefinition/message');
    const sdTypeRec = r.records.find((x) => (x.field as string) === 'sd.type');
    expect(sdTypeRec?.newValue).toBe('http://openehr.org/fhir/StructureDefinition/message');
  });

  it('mixed pin/non-pin targetProfile array: only the non-pinned element is rewritten', () => {
    // Guards against a future regression where the pin check inside
    // tryEmitCrossRefEdit (or its caller's array loop) is changed
    // from per-element to per-array short-circuit.
    const fixture = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "MESSAGE",',
      '  "url" : "http://openehr.org/fhir/StructureDefinition/MESSAGE",',
      '  "type" : "http://openehr.org/fhir/StructureDefinition/MESSAGE",',
      '  "differential" : {',
      '    "element" : [{',
      '      "type" : [{',
      `        "targetProfile" : ["${PINNED_ANY}", "http://example.org/sd/OTHER"]`,
      '      }]',
      '    }]',
      '  }',
      '}',
    ]);
    const discovered = new Set([
      PINNED_ANY,
      'http://example.org/sd/OTHER',
      'http://openehr.org/fhir/StructureDefinition/MESSAGE',
    ]);
    const r = planSC(fixture, 'lower_snake', discovered);
    expect(r.errors).toEqual([]);
    const crossRefRecs = r.records.filter((x) =>
      (x.field as string).includes('targetProfile'),
    );
    expect(crossRefRecs).toHaveLength(1);
    expect(crossRefRecs[0]!.field as string).toContain('targetProfile[1]');
    expect(crossRefRecs[0]!.newValue).toBe('http://example.org/sd/other');
    // No record at targetProfile[0] (the pinned element).
    expect(
      r.records.some((x) => (x.field as string).includes('targetProfile[0]')),
    ).toBe(false);
  });
});

describe('planSdCanonicalRewrite (pinned-resolver branch)', () => {
  const PINNED_ANY = 'http://openehr.org/fhir/StructureDefinition/Any';

  it('divergent type resolved to pinned canonical: refuse-to-rewrite (no edit, no record)', () => {
    // Sibling SD whose `type` last segment tokenizes to the pinned `Any`.
    // The resolver would normally rewrite the `type` literal; the pin
    // makes it refuse-to-rewrite (mirrors the `ambiguous` branch shape).
    // The sibling's own `url` IS re-cased (proves the resolver refusal
    // does NOT abort the rest of the planner — typeResolved=true only
    // suppresses the `type` re-case path, not the `url` one).
    const sibling = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "MY-SIBLING",',
      '  "url" : "http://example.org/sd/MY-SIBLING",',
      '  "type" : "Any"',
      '}',
    ]);
    const pinned = crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "Any",',
      `  "url" : "${PINNED_ANY}"`,
      '}',
    ]);
    const discovery = discoverSdCanonicals([
      { relPath: 'sibling.json', source: sibling, root: parseTree(sibling)! },
      { relPath: 'any.json', source: pinned, root: parseTree(pinned)! },
    ]);
    const r = planSCWithIndex(sibling, 'lower-kebab', discovery.canonicals, discovery.index);
    expect(r.errors).toEqual([]);
    // No type-resolve record (refuse-to-rewrite) and no `sd.type` record.
    const fields = r.records.map((x) => x.field as string);
    expect(fields).not.toContain('sd.type-resolve');
    expect(fields).not.toContain('sd.type');
    // The sibling's own url IS re-cased.
    const urlRec = r.records.find((x) => (x.field as string) === 'sd.url');
    expect(urlRec?.newValue).toBe('http://example.org/sd/my-sibling');
  });
});

describe('runWith (end-to-end) > --structure-canonical', () => {
  it('end-to-end --structure-canonical resolves divergent type via the discovered-SD index (ADDRESSED-MESSAGE-style)', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'ADDRESSED-MESSAGE.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "ADDRESSED-MESSAGE",',
        '  "url" : "http://openehr.org/fhir/StructureDefinition/ADDRESSED-MESSAGE",',
        '  "type" : "http://openehr.org/fhir/StructureDefinition/ADDRESSED_MESSAGE",',
        '  "baseDefinition" : "http://openehr.org/fhir/StructureDefinition/MESSAGE"',
        '}',
      ]));
      writeFixture(dir, 'MESSAGE.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "MESSAGE",',
        '  "url" : "http://openehr.org/fhir/StructureDefinition/MESSAGE",',
        '  "type" : "http://openehr.org/fhir/StructureDefinition/MESSAGE"',
        '}',
      ]));
      const r = captureRun(['--structure-canonical', 'lower_snake', '--update'], dir);
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      const a = readFileSync(join(dir, 'ADDRESSED-MESSAGE.json'), 'utf8');
      // url re-cased; type rewritten by the resolver (and re-cased too).
      expect(a).toContain('"url" : "http://openehr.org/fhir/StructureDefinition/addressed_message"');
      expect(a).toContain('"type" : "http://openehr.org/fhir/StructureDefinition/addressed_message"');
      expect(a).toContain('"baseDefinition" : "http://openehr.org/fhir/StructureDefinition/message"');
      // The report mentions the resolve action (via the sd.type-resolve
      // field name, rendered without the "sd." prefix).
      expect(r.out).toContain('ADDRESSED-MESSAGE.type-resolve');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('end-to-end --structure-canonical reports the new ambiguous-type error and skips the file', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'A.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "FOO-BAR",',
        '  "url" : "http://a.example.org/sd/FOO-BAR",',
        '  "type" : "http://a.example.org/sd/FOO-BAR"',
        '}',
      ]));
      writeFixture(dir, 'B.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "foo_bar",',
        '  "url" : "http://b.example.org/sd/foo_bar",',
        '  "type" : "http://b.example.org/sd/foo_bar"',
        '}',
      ]));
      const clientOriginal = crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "CLIENT",',
        '  "url" : "http://c.example.org/sd/CLIENT",',
        '  "type" : "FooBar"',
        '}',
      ]);
      writeFixture(dir, 'CLIENT.json', clientOriginal);
      const r = captureRun(['--structure-canonical', 'lower_snake', '--update'], dir);
      // Ambiguous-type counts as an error, so exit code is 1.
      expect(r.code).toBe(1);
      expect(r.out).toContain("type 'FooBar' is ambiguous");
      // The CLIENT file is left untouched (zero edits emitted for it).
      const clientAfter = readFileSync(join(dir, 'CLIENT.json'), 'utf8');
      expect(clientAfter).toBe(clientOriginal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('end-to-end --structure-canonical Upper-Kebab + --update with cross-refs', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'ACTIVITY.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "ACTIVITY",',
        '  "url" : "http://example.org/sd/activity",',
        '  "type" : "http://example.org/sd/activity",',
        '  "differential" : {',
        '    "element" : [{',
        '      "type" : [{ "code" : "http://example.org/sd/event" }]',
        '    }]',
        '  }',
        '}',
      ]));
      writeFixture(dir, 'EVENT.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "EVENT",',
        '  "url" : "http://example.org/sd/event",',
        '  "type" : "http://example.org/sd/event"',
        '}',
      ]));
      const r = captureRun(['--structure-canonical', 'UPPER-KEBAB', '--update'], dir);
      expect(r.code).toBe(0);
      const a = readFileSync(join(dir, 'ACTIVITY.json'), 'utf8');
      const e = readFileSync(join(dir, 'EVENT.json'), 'utf8');
      expect(a).toContain('"url" : "http://example.org/sd/ACTIVITY"');
      expect(a).toContain('"type" : "http://example.org/sd/ACTIVITY"');
      expect(a).toContain('"code" : "http://example.org/sd/EVENT"');
      expect(e).toContain('"url" : "http://example.org/sd/EVENT"');
      expect(e).toContain('"type" : "http://example.org/sd/EVENT"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('end-to-end --structure-canonical camel + --update accepts the previously-restricted camel case', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'ACTIVITY.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "ACTIVITY",',
        '  "url" : "http://example.org/sd/activity-item-structure",',
        '  "type" : "http://example.org/sd/activity-item-structure"',
        '}',
      ]));
      const r = captureRun(['--structure-canonical', 'camel', '--update'], dir);
      expect(r.code).toBe(0);
      const a = readFileSync(join(dir, 'ACTIVITY.json'), 'utf8');
      expect(a).toContain('"url" : "http://example.org/sd/activityItemStructure"');
      expect(a).toContain('"type" : "http://example.org/sd/activityItemStructure"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CodeSystem file with same final segment is byte-identical after --structure-canonical run', () => {
    const dir = makeTempDir();
    try {
      const csOriginal = crlf([
        '{',
        '  "resourceType" : "CodeSystem",',
        '  "id" : "ACTIVITY",',
        '  "url" : "http://example.org/cs/ACTIVITY"',
        '}',
      ]);
      writeFixture(dir, 'CS-ACTIVITY.json', csOriginal);
      writeFixture(dir, 'ACTIVITY.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "ACTIVITY",',
        '  "url" : "http://example.org/sd/ACTIVITY"',
        '}',
      ]));
      const r = captureRun(['--structure-canonical', 'lower_snake', '--update'], dir);
      expect(r.code).toBe(0);
      // CodeSystem's url is not in the discovered SD set; no rewrite.
      const csAfter = readFileSync(join(dir, 'CS-ACTIVITY.json'), 'utf8');
      expect(csAfter).toBe(csOriginal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('composes operation-side + sd-side + sd-canonical in one --update pass with CRLF preserved', () => {
    const dir = makeTempDir();
    try {
      const original = crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "ACTIVITY",',
        '  "url" : "http://example.org/sd/ACTIVITY",',
        '  "type" : "http://example.org/sd/ACTIVITY",',
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "less-than",',
        '    "name" : "LessThan",',
        '    "code" : "less_than"',
        '  }],',
        '  "extension" : [{',
        '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
        '    "valueCanonical" : "#less-than"',
        '  }]',
        '}',
      ]);
      writeFixture(dir, 'ACTIVITY.json', original);
      const r = captureRun([
        '--operation-id', 'lower_snake',
        '--structure-id', 'lower-kebab',
        '--structure-canonical', 'UPPER-KEBAB',
        '--update',
      ], dir);
      expect(r.code).toBe(0);
      const after = readFileSync(join(dir, 'ACTIVITY.json'), 'utf8');
      expect(after).toContain('"id" : "activity"'); // structure-id (SD)
      expect(after).toContain('"id" : "less_than"'); // operation-id (OpDef)
      expect(after).toContain('"url" : "http://example.org/sd/ACTIVITY"'); // already Upper-Kebab segment
      expect(after).toContain('"valueCanonical" : "#less_than"'); // operation #ref synced
      // Trailing byte preserved (CRLF input ended with `}`).
      expect(after.charCodeAt(after.length - 1)).toBe(original.charCodeAt(original.length - 1));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Phase 5: cross-cutting + report-format polish
  // -------------------------------------------------------------------------

  it('preview-by-default matrix run (no --update) leaves every file byte-identical on disk', () => {
    const dir = makeTempDir();
    try {
      const aOriginal = crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "ACTIVITY",',
        '  "url" : "http://example.org/sd/activity",',
        '  "type" : "http://example.org/sd/activity",',
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "magnitude",',
        '    "name" : "magnitude",',
        '    "code" : "magnitude"',
        '  }]',
        '}',
      ]);
      const eOriginal = crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "EVENT",',
        '  "url" : "http://example.org/sd/event"',
        '}',
      ]);
      writeFixture(dir, 'ACTIVITY.json', aOriginal);
      writeFixture(dir, 'EVENT.json', eOriginal);
      const r = captureRun([
        '--operation-id', 'lower-kebab',
        '--structure-id', 'lower-kebab',
        '--structure-canonical', 'UPPER-KEBAB',
      ], dir);
      expect(r.code).toBe(0);
      // Report mentions changes; bytes on disk are unchanged.
      expect(r.out).toContain('change(s) across');
      expect(readFileSync(join(dir, 'ACTIVITY.json'), 'utf8')).toBe(aOriginal);
      expect(readFileSync(join(dir, 'EVENT.json'), 'utf8')).toBe(eOriginal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SD-canonical cross-ref records render with differential./snapshot. prefix dropped', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'ACTIVITY.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "ACTIVITY",',
        '  "url" : "http://example.org/sd/activity",',
        '  "differential" : {',
        '    "element" : [{',
        '      "type" : [{ "code" : "http://example.org/sd/event" }]',
        '    }]',
        '  },',
        '  "snapshot" : {',
        '    "element" : [{',
        '      "type" : [{ "profile" : ["http://example.org/sd/event"] }]',
        '    }]',
        '  }',
        '}',
      ]));
      writeFixture(dir, 'EVENT.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "EVENT",',
        '  "url" : "http://example.org/sd/event"',
        '}',
      ]));
      const r = captureRun(['--structure-canonical', 'UPPER-KEBAB'], dir);
      expect(r.code).toBe(0);
      // Cross-ref records render with the differential./snapshot. prefix
      // collapsed; we should see "ACTIVITY.element[0].type[0].code" not
      // "ACTIVITY.differential.element[0].type[0].code".
      expect(r.out).toContain('ACTIVITY.element[0].type[0].code');
      expect(r.out).toContain('ACTIVITY.element[0].type[0].profile[0]');
      expect(r.out).not.toContain('ACTIVITY.differential.element');
      expect(r.out).not.toContain('ACTIVITY.snapshot.element');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runWith (end-to-end) > pinned `Any` SD', () => {
  const PINNED_ANY = 'http://openehr.org/fhir/StructureDefinition/Any';

  function pinnedAnyFixture(): string {
    return crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      '  "id" : "Any",',
      '  "name" : "Any",',
      '  "title" : "Any",',
      `  "url" : "${PINNED_ANY}",`,
      `  "type" : "${PINNED_ANY}",`,
      '  "abstract" : true,',
      '  "kind" : "logical",',
      '  "baseDefinition" : "http://hl7.org/fhir/StructureDefinition/Base"',
      '}',
    ]);
  }

  function siblingFixture(name: string, basePinned: boolean): string {
    return crlf([
      '{',
      '  "resourceType" : "StructureDefinition",',
      `  "id" : "${name}",`,
      `  "url" : "http://openehr.org/fhir/StructureDefinition/${name}",`,
      `  "type" : "http://openehr.org/fhir/StructureDefinition/${name}",`,
      `  "baseDefinition" : "${basePinned ? PINNED_ANY : 'http://hl7.org/fhir/StructureDefinition/Base'}"`,
      '}',
    ]);
  }

  it('per-file no-op (preview): Any.json absent from report; sibling files still process', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'Any.json', pinnedAnyFixture());
      writeFixture(dir, 'MESSAGE.json', siblingFixture('MESSAGE', true));
      const r = captureRun(
        ['--structure-id', 'lower-kebab', '--structure-canonical', 'lower-kebab'],
        dir,
      );
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('Any.json');
      expect(r.out).toContain('MESSAGE.id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('per-file no-op (--update): Any.json byte-identical on disk', () => {
    const dir = makeTempDir();
    try {
      const original = pinnedAnyFixture();
      writeFixture(dir, 'Any.json', original);
      writeFixture(dir, 'MESSAGE.json', siblingFixture('MESSAGE', true));
      const r = captureRun(
        ['--structure-id', 'lower-kebab', '--structure-canonical', 'lower-kebab', '--update'],
        dir,
      );
      expect(r.code).toBe(0);
      const after = readFileSync(join(dir, 'Any.json'), 'utf8');
      expect(after).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cross-ref pin (--structure-canonical only, --update): isolates the cross-ref gate from the per-file gate', () => {
    const dir = makeTempDir();
    try {
      const anyOriginal = pinnedAnyFixture();
      writeFixture(dir, 'Any.json', anyOriginal);
      writeFixture(dir, 'MESSAGE.json', siblingFixture('MESSAGE', true));
      const r = captureRun(
        ['--structure-canonical', 'lower-kebab', '--update'],
        dir,
      );
      expect(r.code).toBe(0);
      // Any.json untouched.
      expect(readFileSync(join(dir, 'Any.json'), 'utf8')).toBe(anyOriginal);
      // MESSAGE's baseDefinition value still literally the pinned canonical.
      const m = readFileSync(join(dir, 'MESSAGE.json'), 'utf8');
      expect(m).toContain(`"baseDefinition" : "${PINNED_ANY}"`);
      // MESSAGE's own url and type ARE re-cased.
      expect(m).toContain('"url" : "http://openehr.org/fhir/StructureDefinition/message"');
      expect(m).toContain('"type" : "http://openehr.org/fhir/StructureDefinition/message"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cross-ref pin (combined matrix, --update): per-file + cross-ref both fire, no /any in report', () => {
    const dir = makeTempDir();
    try {
      const anyOriginal = pinnedAnyFixture();
      writeFixture(dir, 'Any.json', anyOriginal);
      writeFixture(dir, 'MESSAGE.json', siblingFixture('MESSAGE', true));
      const r = captureRun(
        ['--structure-id', 'lower-kebab', '--structure-canonical', 'lower-kebab', '--update'],
        dir,
      );
      expect(r.code).toBe(0);
      // Any.json untouched.
      expect(readFileSync(join(dir, 'Any.json'), 'utf8')).toBe(anyOriginal);
      // MESSAGE's baseDefinition still pinned.
      const m = readFileSync(join(dir, 'MESSAGE.json'), 'utf8');
      expect(m).toContain(`"baseDefinition" : "${PINNED_ANY}"`);
      // Report contains MESSAGE's id and url records.
      expect(r.out).toContain('MESSAGE.id');
      expect(r.out).toContain('MESSAGE.url');
      // No record line whose newValue ends in /any.
      expect(r.out).not.toMatch(/-> "[^"]*\/any"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('op-side flags also no-op against `Any`: file with a synthesized contained OpDef stays byte-identical', () => {
    const dir = makeTempDir();
    try {
      const original = crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "id" : "Any",',
        `  "url" : "${PINNED_ANY}",`,
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "MAGNITUDE",',
        '    "name" : "MAGNITUDE",',
        '    "code" : "MAGNITUDE"',
        '  }]',
        '}',
      ]);
      writeFixture(dir, 'Any.json', original);
      const r = captureRun(['--operation-id', 'lower_snake', '--update'], dir);
      expect(r.code).toBe(0);
      expect(readFileSync(join(dir, 'Any.json'), 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('idempotence: a second --update run after the first reports zero changes', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'Any.json', pinnedAnyFixture());
      writeFixture(dir, 'MESSAGE.json', siblingFixture('MESSAGE', true));
      const argv = ['--structure-id', 'lower-kebab', '--structure-canonical', 'lower-kebab', '--update'];
      const r1 = captureRun(argv, dir);
      expect(r1.code).toBe(0);
      const r2 = captureRun(argv, dir);
      expect(r2.code).toBe(0);
      // Second run should produce zero edit lines (no -> arrows).
      expect(r2.out).not.toContain(' -> ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('malformed Any.json still surfaces as a parse error (pin gate must come AFTER parse-error early-return)', () => {
    const dir = makeTempDir();
    try {
      // Truncated: missing closing brace.
      const malformed = `{"resourceType": "StructureDefinition", "url": "${PINNED_ANY}"`;
      writeFixture(dir, 'Any.json', malformed);
      const r = captureRun(['--structure-id', 'lower-kebab'], dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain('malformed JSON:');
      expect(r.out).toContain('Any.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runWith (end-to-end)', () => {
  it('emits the expected report and writes byte-identical post-edit bytes', () => {
    const dir = makeTempDir();
    try {
      // ALPHA.json: needs an id flip and a #ref rewrite under all-snake.
      writeFixture(dir, 'ALPHA.json', crlf([
        '{',
        '  "resourceType" : "StructureDefinition",',
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "less-than",',
        '    "name" : "LessThan",',
        '    "title" : "less_than",',
        '    "code" : "less_than"',
        '  }],',
        '  "extension" : [{',
        '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
        '    "valueCanonical" : "#less-than"',
        '  }]',
        '}',
      ]));
      // BETA.json: zero changes (already snake everywhere); should be omitted from per-file blocks.
      writeFixture(dir, 'BETA.json', crlf([
        '{',
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "magnitude",',
        '    "name" : "magnitude",',
        '    "title" : "magnitude",',
        '    "code" : "magnitude"',
        '  }]',
        '}',
      ]));

      const result = captureRun([
        '--operation-id', 'lower_snake',
        '--operation-name', 'lower_snake',
        '--operation-title', 'lower_snake',
        '--update',
      ], dir);
      expect(result.code).toBe(0);
      // --operation-id lower_snake legitimately emits the FHIR-id underscore warning.
      expect(result.err).toContain('--operation-id=lower_snake');
      // Per-file block for ALPHA only; BETA omitted.
      expect(result.out).toContain('=== ');
      expect(result.out).toContain('ALPHA.json');
      expect(result.out).not.toContain('BETA.json');
      expect(result.out).toContain('less-than.id: "less-than" -> "less_than"');
      expect(result.out).toContain('less-than.name: "LessThan" -> "less_than"');
      expect(result.out).toContain('less_than.valueCanonical: "#less-than" -> "#less_than"');
      expect(result.out.trimEnd().endsWith('3 change(s) across 1 file(s).')).toBe(true);

      // Files should be written; verify ALPHA bytes byte-by-byte.
      const alphaOut = readFileSync(join(dir, 'ALPHA.json'), 'utf8');
      expect(alphaOut).toContain('"id" : "less_than"');
      expect(alphaOut).toContain('"name" : "less_than"');
      expect(alphaOut).toContain('"valueCanonical" : "#less_than"');
      // BETA must be byte-identical.
      const betaIn = crlf([
        '{',
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "magnitude",',
        '    "name" : "magnitude",',
        '    "title" : "magnitude",',
        '    "code" : "magnitude"',
        '  }]',
        '}',
      ]);
      const betaOut = readFileSync(join(dir, 'BETA.json'), 'utf8');
      expect(betaOut).toBe(betaIn);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent end-to-end (second run reports zero changes)', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'GAMMA.json', crlf([
        '{',
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "less-than",',
        '    "name" : "LessThan",',
        '    "title" : "less_than",',
        '    "code" : "less_than"',
        '  }]',
        '}',
      ]));

      const r1 = captureRun([
        '--operation-id', 'lower_snake',
        '--operation-name', 'lower_snake',
        '--operation-title', 'lower_snake',
        '--update',
      ], dir);
      expect(r1.code).toBe(0);

      const r2 = captureRun([
        '--operation-id', 'lower_snake',
        '--operation-name', 'lower_snake',
        '--operation-title', 'lower_snake',
        '--update',
      ], dir);
      expect(r2.code).toBe(0);
      expect(r2.out.trimEnd().endsWith('0 change(s) across 0 file(s).')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preview is the default: runs without --update do not write files (byte-identical on disk)', () => {
    const dir = makeTempDir();
    try {
      const original = crlf([
        '{',
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "less-than",',
        '    "name" : "LessThan",',
        '    "title" : "less_than",',
        '    "code" : "less_than"',
        '  }]',
        '}',
      ]);
      writeFixture(dir, 'DELTA.json', original);
      const r = captureRun(['--operation-id', 'lower_snake'], dir);
      expect(r.code).toBe(0);
      expect(r.out).toContain('DELTA.json');
      const after = readFileSync(join(dir, 'DELTA.json'), 'utf8');
      expect(after).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--operation-id + --operation-canonical #ref together: redundant-but-allowed (no warning, no double-edit)', () => {
    // Fixture where the contained OpDef id is out of sync with the
    // #ref. Under --operation-id, the id-casing pipeline already syncs
    // the #ref. Adding --operation-canonical #ref must not double-edit
    // and must not emit a warning.
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'REDUN.json', crlf([
        '{',
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "is-strictly-comparable-to",',
        '    "name" : "IsStrictlyComparableTo",',
        '    "code" : "is_strictly_comparable_to"',
        '  }],',
        '  "extension" : [{',
        '    "url" : "http://hl7.org/fhir/tools/StructureDefinition/type-operation",',
        '    "valueCanonical" : "#is_strictly_comparable_to"',
        '  }]',
        '}',
      ]));
      const r = captureRun([
        '--operation-id', 'lower_snake',
        '--operation-canonical', '#ref',
        '--update',
      ], dir);
      expect(r.code).toBe(0);
      // --operation-id lower_snake emits the FHIR-id underscore warning;
      // no other stderr lines should appear.
      expect(r.err.trimEnd().split('\n').length).toBe(1);
      expect(r.err).toContain('--operation-id=lower_snake');
      const after = readFileSync(join(dir, 'REDUN.json'), 'utf8');
      // id moved to snake; #ref already snake stays snake; no double-write
      // would be visible in the bytes anyway, but the file must parse and
      // the values must agree.
      expect(after).toContain('"id" : "is_strictly_comparable_to"');
      expect(after).toContain('"valueCanonical" : "#is_strictly_comparable_to"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--operation-canonical #ref alone behaves like the old --repair (sync only)', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'BROKENREF.json', crlf([
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
      ]));
      const r = captureRun(['--operation-canonical', '#ref', '--update'], dir);
      expect(r.code).toBe(0);
      expect(r.out).toContain('valueCanonical');
      const after = readFileSync(join(dir, 'BROKENREF.json'), 'utf8');
      expect(after).toContain('"valueCanonical" : "#is-strictly-comparable-to"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exit 1 when a file has malformed JSON', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'BROKEN.json', '{ this is not json');
      writeFixture(dir, 'OK.json', crlf([
        '{',
        '  "contained" : [{',
        '    "resourceType" : "OperationDefinition",',
        '    "id" : "magnitude",',
        '    "code" : "magnitude"',
        '  }]',
        '}',
      ]));
      const r = captureRun([
        '--operation-id', 'lower_snake',
        '--operation-name', 'lower_snake',
        '--operation-title', 'lower_snake',
        '--update',
      ], dir);
      expect(r.code).toBe(1);
      expect(r.out).toContain('BROKEN.json');
      expect(r.out.toLowerCase()).toContain('error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exit 2 with no flags', () => {
    const dir = makeTempDir();
    try {
      const r = captureRun([], dir);
      expect(r.code).toBe(2);
      expect(r.err).toContain('nothing to do');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--help prints usage and exits 0 (no file walk)', () => {
    const r = captureRun(['--help'], '/this/dir/does/not/exist');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage:');
    expect(r.err).toBe('');
  });

  it('--help advertises the unified 8-name allowlist and the case-insensitive parser tagline', () => {
    const r = captureRun(['--help'], '/this/dir/does/not/exist');
    expect(r.code).toBe(0);
    expect(r.out).toContain('lower_snake');
    expect(r.out).toContain('lower-kebab');
    expect(r.out).toContain('Title_Snake');
    expect(r.out).toContain('Title-Kebab');
    expect(r.out).toContain('UPPER_SNAKE');
    expect(r.out).toContain('UPPER-KEBAB');
    expect(r.out).toContain('camel');
    expect(r.out).toContain('Pascal');
    expect(r.out).toContain('case-insensitive');
    expect(r.out).toContain("warns if case contains '_'");
  });
});

describe('runWith warnings (id-flag underscore)', () => {
  it('--operation-id lower_snake emits a single FHIR-id warning to stderr', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'EMPTY.json', '{}');
      const r = captureRun(['--operation-id', 'lower_snake'], dir);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/^warning: FHIR id values forbid '_'/);
      expect(r.err).toContain('--operation-id=lower_snake');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--operation-id UPPER_SNAKE emits a warning naming the chosen case', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'EMPTY.json', '{}');
      const r = captureRun(['--operation-id', 'UPPER_SNAKE'], dir);
      expect(r.code).toBe(0);
      expect(r.err).toContain('--operation-id=UPPER_SNAKE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--structure-id Title_Snake emits a warning naming --structure-id', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'EMPTY.json', '{}');
      const r = captureRun(['--structure-id', 'Title_Snake'], dir);
      expect(r.code).toBe(0);
      expect(r.err).toContain('--structure-id=Title_Snake');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--operation-id lower-kebab emits no warning (no underscore in the chosen case)', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'EMPTY.json', '{}');
      const r = captureRun(['--operation-id', 'lower-kebab'], dir);
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('both id flags with underscore-bearing cases emits two warnings (operation then structure)', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'EMPTY.json', '{}');
      const r = captureRun([
        '--operation-id', 'lower_snake',
        '--structure-id', 'lower_snake',
      ], dir);
      expect(r.code).toBe(0);
      const lines = r.err.trimEnd().split('\n');
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('--operation-id=lower_snake');
      expect(lines[1]).toContain('--structure-id=lower_snake');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exit code remains 0 for an otherwise-valid invocation that triggered warnings', () => {
    const dir = makeTempDir();
    try {
      writeFixture(dir, 'EMPTY.json', '{}');
      const r = captureRun(['--operation-id', 'lower_snake'], dir);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

