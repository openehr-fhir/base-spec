#!/usr/bin/env bun
// Bulk-toggle casing of openEHR type-function OperationDefinitions.
// See tools/README.md for full usage. This is a Phase-1 stub; the real
// pipeline is wired in later phases.

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

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.length === 0) {
    process.stderr.write(
      "error: nothing to do; pass --all-snake, --all-fhir, --id-case/--name-case/--title-case, or --repair\n"
    );
    return 2;
  }
  // Phase 1 stub: real pipeline is implemented in later phases.
  process.stdout.write("0 change(s) across 0 file(s).\n");
  return 0;
}

const code = main(process.argv.slice(2));
process.exit(code);
