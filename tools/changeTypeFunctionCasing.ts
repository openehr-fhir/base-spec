#!/usr/bin/env bun
// Bulk-toggle casing of openEHR type-function OperationDefinitions.
// See tools/README.md for full usage. The pipeline (file walk + edit
// construction + report) is wired up in later phases; this module owns
// argv parsing and process exit semantics.

import { parseArgv } from "./lib/argv.ts";

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
`;

export function main(argv: readonly string[]): number {
  const parsed = parseArgv(argv);
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  // Phase 3 stub: pipeline wired up in later phases.
  process.stdout.write("0 change(s) across 0 file(s).\n");
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

