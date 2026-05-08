#!/usr/bin/env bun
// Bulk-toggle casing of openEHR type-function OperationDefinitions and
// (Phase 3+) the parent StructureDefinition's id/name/title and (Phase 4+)
// canonical-URL trio. See tools/README.md for full usage.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  applyEdits,
  parseTree,
  printParseErrorCode,
  type Edit,
} from "jsonc-parser";
import { parseArgv, type ParsedArgs } from "./lib/argv.ts";
import { planCaseChanges, type ChangeRecord } from "./lib/edits.ts";
import { planRepair } from "./lib/repair.ts";

const HELP = `changeTypeFunctionCasing - re-case openEHR type-function OperationDefinitions
and the parent StructureDefinition.

Usage:
  bun tools/changeTypeFunctionCasing.ts [matrix flags] [--update]

Operation-side flags (re-case contained OperationDefinitions):
  --operation-id <case>          (alias: --op-id)
                                 lower_snake | lower-kebab
  --operation-name <case>        (alias: --op-name)
                                 lower_snake | lower-kebab | Upper-Kebab
                                 | Title-Kebab | Pascal-Kebab | lowerCamel
                                 | UpperPascal
  --operation-title <case>       (alias: --op-title)
                                 same value set as --operation-name
  --operation-canonical <#ref>   (alias: --op-canonical)
                                 sentinel: one of {none, na, ref, #, #ref}.
                                 Sync the type-operation valueCanonical
                                 #refs to match contained OpDef.id values.

Structure-side flags (re-case the parent StructureDefinition):
  --structure-id <case>          (alias: --sd-id)
                                 lower_snake | lower-kebab
  --structure-name <case>        (alias: --sd-name)
                                 same values as --operation-name
  --structure-title <case>       (alias: --sd-title)
                                 same values as --operation-name
  --structure-canonical <case>   (alias: --sd-canonical)
                                 lower_snake | lower-kebab | Upper-Kebab
                                 | Title-Kebab | Pascal-Kebab.
                                 Re-case the SD's url/type/baseDefinition
                                 final segment AND every in-package
                                 reference to a discovered SD canonical.

Mode flags:
  --update, -u                   Apply edits. Default is preview-only.
  --help, -h                     Print this message.

At least one matrix flag must be present (or --help).

Operates on every *.json directly under input/resources/ (resolved
relative to the current working directory). The summary line counts
files that contain at least one change.

Exit codes:
  0  success (any number of changes, including zero)
  1  one or more files reported errors
  2  argv/usage error

Tip: --operation-canonical typically needs shell quoting on POSIX
shells (the '#' is a comment character). PowerShell is fine.

See tools/README.md for examples and the full flag-combination rules.
`;

interface FileResult {
  relPath: string;
  records: ChangeRecord[];
  errors: string[];
  /** New file source if changes were applied (and write should occur). */
  newSource: string | null;
}

function processFile(
  absPath: string,
  relPath: string,
  args: ParsedArgs,
): FileResult {
  const source = readFileSync(absPath, "utf8");
  const parseErrors: import("jsonc-parser").ParseError[] = [];
  const root = parseTree(source, parseErrors);
  if (!root || parseErrors.length > 0) {
    const messages = parseErrors.map(
      (e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`,
    );
    return {
      relPath,
      records: [],
      errors: [`malformed JSON: ${messages.join(", ") || "no parseable root"}`],
      newSource: null,
    };
  }

  // Unified pipeline: always run planCaseChanges with whatever matrix
  // cases were provided; additionally run planRepair when the user
  // asked for ref-sync but did NOT pass --operation-id (id-casing
  // already syncs the #refs, so combining them would double-edit).
  const allEdits: Edit[] = [];
  const allRecords: ChangeRecord[] = [];
  const allErrors: string[] = [];

  const cc = planCaseChanges({
    source,
    root,
    idCase: args.operationIdCase,
    nameCase: args.operationNameCase,
    titleCase: args.operationTitleCase,
  });
  allErrors.push(...cc.errors);
  allEdits.push(...cc.edits);
  allRecords.push(...cc.records);

  if (
    args.operationCanonicalRefSync &&
    args.operationIdCase === null
  ) {
    const rp = planRepair({ source, root });
    allErrors.push(...rp.errors);
    allEdits.push(...rp.edits);
    allRecords.push(...rp.records);
  }

  if (allErrors.length > 0) {
    return { relPath, records: [], errors: allErrors, newSource: null };
  }
  if (allEdits.length === 0) {
    return { relPath, records: [], errors: [], newSource: null };
  }

  // Sort edits by offset before applying.
  allEdits.sort((a, b) => a.offset - b.offset);

  // Defensive overlap check: each planner emits non-overlapping edits;
  // when planners are merged we revalidate the joined sequence.
  for (let i = 1; i < allEdits.length; i++) {
    const prev = allEdits[i - 1]!;
    const cur = allEdits[i]!;
    if (prev.offset + prev.length > cur.offset) {
      return {
        relPath,
        records: [],
        errors: [`internal error: overlapping edits at offset ${cur.offset}`],
        newSource: null,
      };
    }
  }

  const newSource = applyEdits(source, allEdits);
  return { relPath, records: allRecords, errors: [], newSource };
}

function formatRecords(records: readonly ChangeRecord[]): string[] {
  const lines: string[] = [];
  for (const r of records) {
    if (r.oldValue === null) {
      lines.push(`  ${r.opId}.${r.field}: <inserted> "${r.newValue}"`);
    } else {
      lines.push(`  ${r.opId}.${r.field}: "${r.oldValue}" -> "${r.newValue}"`);
    }
  }
  return lines;
}

export interface RunOptions {
  /** Absolute or repo-relative path to the resources directory. */
  resourcesDir: string;
  /** stdout writer. */
  out: (s: string) => void;
  /** stderr writer. */
  err: (s: string) => void;
}

export function runWith(
  argv: readonly string[],
  opts: RunOptions,
): number {
  const parsed = parseArgv(argv);
  if ("error" in parsed) {
    opts.err(parsed.error + "\n");
    return 2;
  }
  if (parsed.help) {
    opts.out(HELP);
    return 0;
  }

  let entries: string[];
  try {
    entries = readdirSync(opts.resourcesDir);
  } catch (e) {
    opts.err(
      `error: cannot read resources directory '${opts.resourcesDir}': ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }

  const files = entries
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  let totalChanges = 0;
  let filesWithChanges = 0;
  let errorCount = 0;
  const blocks: string[] = [];

  for (const name of files) {
    const abs = join(opts.resourcesDir, name);
    const rel = relative(process.cwd(), abs).replace(/\\/g, "/");
    const result = processFile(abs, rel, parsed);
    if (result.errors.length > 0) {
      const lines: string[] = [`=== ${rel} ===`];
      for (const e of result.errors) lines.push(`  error: ${e}`);
      blocks.push(lines.join("\n"));
      errorCount += result.errors.length;
      continue;
    }
    if (result.records.length === 0) continue;
    const lines: string[] = [`=== ${rel} ===`, ...formatRecords(result.records)];
    blocks.push(lines.join("\n"));
    totalChanges += result.records.length;
    filesWithChanges++;

    if (parsed.update && result.newSource !== null) {
      const original = readFileSync(abs);
      const last = original.length > 0 ? original[original.length - 1] : -1;
      const newBuf = Buffer.from(result.newSource, "utf8");
      const newLast = newBuf.length > 0 ? newBuf[newBuf.length - 1] : -1;
      if (!preservesTrailingByte(last, newLast)) {
        opts.err(
          `error: refusing to write ${rel}: trailing-byte preservation guard failed (old=0x${(last ?? -1).toString(16)} new=0x${(newLast ?? -1).toString(16)})\n`,
        );
        errorCount++;
        continue;
      }
      writeFileSync(abs, newBuf);
    }
  }

  const report = blocks.length > 0 ? blocks.join("\n\n") + "\n\n" : "";
  opts.out(`${report}${totalChanges} change(s) across ${filesWithChanges} file(s).\n`);

  return errorCount > 0 ? 1 : 0;
}

export function preservesTrailingByte(oldLast: number | undefined, newLast: number | undefined): boolean {
  return (oldLast ?? -1) === (newLast ?? -1);
}

export function main(argv: readonly string[]): number {
  return runWith(argv, {
    resourcesDir: join(process.cwd(), "input", "resources"),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
