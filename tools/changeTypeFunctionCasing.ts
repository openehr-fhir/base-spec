#!/usr/bin/env bun
// Bulk-toggle casing of openEHR type-function OperationDefinitions.
// See tools/README.md for full usage.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { applyEdits, parseTree, printParseErrorCode } from "jsonc-parser";
import { parseArgv } from "./lib/argv.ts";
import { planCaseChanges, type ChangeRecord } from "./lib/edits.ts";
import { planRepair } from "./lib/repair.ts";

const HELP = `changeTypeFunctionCasing - re-case openEHR type-function OperationDefinitions.

Usage:
  bun tools/changeTypeFunctionCasing.ts [flags]

Flags (mutually-exclusive groups described in tools/README.md):
  --all-snake             id, name, title -> lower_snake_case; #refs -> #lower_snake_case
  --all-fhir              id -> lower-kebab-case; name+title -> UpperPascalCase; #refs -> #lower-kebab-case
  --id-case <case>        lower_snake | lower-kebab (aliases: lower-hyphen, lower-dash)
  --name-case <case>      lower_snake | lower-kebab | Upper-Kebab | lowerCamel | UpperPascal (+ aliases)
  --title-case <case>     same value set as --name-case
  --repair                rewrite #refs to match the current OperationDefinition.id (no casing change)
  --dry-run               do not write any files; print the change report only
  --help                  print this message

Operates on every *.json directly under input/resources/ (resolved
relative to the current working directory). The summary line counts
files that contain at least one change.

Exit codes:
  0  success (any number of changes, including zero)
  1  one or more files reported errors
  2  argv/usage error, or no case-specifying flag and no --repair

Examples and the full flag-combination rules live in tools/README.md.
Tip: if existing #refs and OpDef ids are out of sync, run --repair
first, then the case-changing flag of your choice.
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
  args: ReturnType<typeof parseArgv>,
): FileResult {
  if ("error" in args) {
    return { relPath, records: [], errors: [args.error], newSource: null };
  }
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
  if (args.repair) {
    const plan = planRepair({ source, root });
    if (plan.errors.length > 0) {
      return { relPath, records: [], errors: plan.errors, newSource: null };
    }
    if (plan.edits.length === 0) {
      return { relPath, records: [], errors: [], newSource: null };
    }
    const newSource = applyEdits(source, plan.edits);
    return { relPath, records: plan.records, errors: [], newSource };
  }
  const plan = planCaseChanges({
    source,
    root,
    idCase: args.idCase,
    nameCase: args.nameCase,
    titleCase: args.titleCase,
  });
  if (plan.errors.length > 0) {
    return { relPath, records: [], errors: plan.errors, newSource: null };
  }
  if (plan.edits.length === 0) {
    return { relPath, records: [], errors: [], newSource: null };
  }
  const newSource = applyEdits(source, plan.edits);
  return { relPath, records: plan.records, errors: [], newSource };
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

    if (!parsed.dryRun && result.newSource !== null) {
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


