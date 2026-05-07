// CLI argv parsing for changeTypeFunctionCasing.
//
// Implements the flag-combination rules from the feature request:
//   - --all-snake and --all-fhir are mutually exclusive
//   - --all-* may not be combined with --id-case/--name-case/--title-case
//   - --repair may not be combined with any case-specifying flag
//   - At least one of: --all-snake, --all-fhir, --id-case, --name-case,
//     --title-case, or --repair must be present
//   - --dry-run may be combined with any of the above
//
// On any rule violation parseArgv returns { error } with a single
// human-readable message; the caller exits with code 2.

import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  ALLOWED_ID_CASES,
  ALLOWED_NAME_CASES,
  type Case,
  parseCaseName,
} from "./casing.ts";

export interface ParsedArgs {
  idCase: Case | null;
  nameCase: Case | null;
  titleCase: Case | null;
  repair: boolean;
  dryRun: boolean;
  help: boolean;
}

export type ParseResult = ParsedArgs | { error: string };

const PARSE_CONFIG: ParseArgsConfig = {
  options: {
    "all-snake": { type: "boolean", default: false },
    "all-fhir": { type: "boolean", default: false },
    "id-case": { type: "string" },
    "name-case": { type: "string" },
    "title-case": { type: "string" },
    repair: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
  allowPositionals: false,
};

export function parseArgv(argv: readonly string[]): ParseResult {
  let raw: ReturnType<typeof parseArgs>;
  try {
    raw = parseArgs({ ...PARSE_CONFIG, args: argv as string[] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `error: ${msg}` };
  }

  const v = raw.values as {
    "all-snake"?: boolean;
    "all-fhir"?: boolean;
    "id-case"?: string;
    "name-case"?: string;
    "title-case"?: string;
    repair?: boolean;
    "dry-run"?: boolean;
    help?: boolean;
  };

  const allSnake = v["all-snake"] === true;
  const allFhir = v["all-fhir"] === true;
  const repair = v.repair === true;
  const dryRun = v["dry-run"] === true;
  const help = v.help === true;

  if (help) {
    return {
      idCase: null,
      nameCase: null,
      titleCase: null,
      repair: false,
      dryRun: false,
      help: true,
    };
  }

  if (allSnake && allFhir) {
    return { error: "error: --all-snake and --all-fhir are mutually exclusive" };
  }

  const hasPerField =
    v["id-case"] !== undefined ||
    v["name-case"] !== undefined ||
    v["title-case"] !== undefined;

  if ((allSnake || allFhir) && hasPerField) {
    return {
      error:
        "error: --all-snake/--all-fhir cannot be combined with --id-case, --name-case, or --title-case",
    };
  }

  if (repair && (allSnake || allFhir || hasPerField)) {
    return {
      error:
        "error: --repair cannot be combined with --all-snake, --all-fhir, --id-case, --name-case, or --title-case",
    };
  }

  let idCase: Case | null = null;
  let nameCase: Case | null = null;
  let titleCase: Case | null = null;

  if (allSnake) {
    idCase = "lower_snake";
    nameCase = "lower_snake";
    titleCase = "lower_snake";
  } else if (allFhir) {
    idCase = "lower-kebab";
    nameCase = "UpperPascal";
    titleCase = "UpperPascal";
  }

  if (v["id-case"] !== undefined) {
    const c = parseCaseName(v["id-case"], ALLOWED_ID_CASES);
    if (!c) {
      return {
        error: `error: --id-case value '${v["id-case"]}' is not allowed (use lower_snake or lower-kebab)`,
      };
    }
    idCase = c;
  }
  if (v["name-case"] !== undefined) {
    const c = parseCaseName(v["name-case"], ALLOWED_NAME_CASES);
    if (!c) {
      return {
        error: `error: --name-case value '${v["name-case"]}' is not allowed (use lower_snake, lower-kebab, Upper-Kebab, lowerCamel, or UpperPascal)`,
      };
    }
    nameCase = c;
  }
  if (v["title-case"] !== undefined) {
    const c = parseCaseName(v["title-case"], ALLOWED_NAME_CASES);
    if (!c) {
      return {
        error: `error: --title-case value '${v["title-case"]}' is not allowed (use lower_snake, lower-kebab, Upper-Kebab, lowerCamel, or UpperPascal)`,
      };
    }
    titleCase = c;
  }

  if (!repair && idCase === null && nameCase === null && titleCase === null) {
    return {
      error:
        "error: nothing to do; pass --all-snake, --all-fhir, --id-case/--name-case/--title-case, or --repair",
    };
  }

  return { idCase, nameCase, titleCase, repair, dryRun, help: false };
}
