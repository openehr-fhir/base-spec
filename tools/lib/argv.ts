// CLI argv parsing for changeTypeFunctionCasing.
//
// New (Phase 2+) flag matrix:
//   Operation-side: --operation-id / --op-id (alias)
//                   --operation-name / --op-name (alias)
//                   --operation-title / --op-title (alias)
//                   --operation-canonical / --op-canonical (alias)
//                       — value must be one of {none, na, ref, #, #ref}
//                         (case-insensitive); means "sync the type-operation
//                         #refs to match contained OpDef.id values".
//   SD-side:        --structure-id / --sd-id (alias)
//                   --structure-name / --sd-name (alias)
//                   --structure-title / --sd-title (alias)
//                   --structure-canonical / --sd-canonical (alias)
//                       — value is a Case from ALLOWED_SC_CASES.
//   Mode flags:     --update / -u (default: preview-only)
//                   --help / -h
//
// Removed legacy flags (Phase 2):
//   --all-snake, --all-fhir, --id-case, --name-case, --title-case,
//   --repair, --dry-run
// Each emits a one-line replacement-hint stderr and exit code 2.

import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  ALLOWED_ID_CASES,
  ALLOWED_NAME_CASES,
  ALLOWED_SC_CASES,
  type Case,
  parseCaseName,
} from "./casing.ts";

export interface ParsedArgs {
  operationIdCase: Case | null;
  operationNameCase: Case | null;
  operationTitleCase: Case | null;
  /** True when --operation-canonical was passed with a sentinel ref-sync value. */
  operationCanonicalRefSync: boolean;
  structureIdCase: Case | null;
  structureNameCase: Case | null;
  structureTitleCase: Case | null;
  structureCanonicalCase: Case | null;
  update: boolean;
  help: boolean;
}

export type ParseResult = ParsedArgs | { error: string };

const REMOVED_FLAG_HINTS: Readonly<Record<string, string>> = {
  "all-snake":
    "removed; pass the equivalent matrix flags (e.g. `--operation-id lower_snake --operation-name lower_snake --operation-title lower_snake`)",
  "all-fhir":
    "removed; pass the equivalent matrix flags (e.g. `--operation-id lower-kebab --operation-name UpperPascal --operation-title UpperPascal`)",
  "id-case": "renamed to `--operation-id`",
  "name-case": "renamed to `--operation-name`",
  "title-case": "renamed to `--operation-title`",
  repair: "removed; pass `--operation-canonical #ref`",
  "dry-run":
    "removed; preview is the default. Pass `--update` (`-u`) to apply changes.",
};

const OP_CANONICAL_SENTINELS: ReadonlySet<string> = new Set([
  "none",
  "na",
  "ref",
  "#",
  "#ref",
]);

/**
 * Resolve an --operation-canonical value to a boolean: true when the
 * value is one of the documented sentinels (case-insensitive), null
 * for any other input (the caller turns this into a usage error).
 */
export function parseOpCanonicalSentinel(input: string): boolean | null {
  if (typeof input !== "string") return null;
  return OP_CANONICAL_SENTINELS.has(input.toLowerCase()) ? true : null;
}

const PARSE_CONFIG: ParseArgsConfig = {
  options: {
    "operation-id": { type: "string" },
    "op-id": { type: "string" },
    "operation-name": { type: "string" },
    "op-name": { type: "string" },
    "operation-title": { type: "string" },
    "op-title": { type: "string" },
    "operation-canonical": { type: "string" },
    "op-canonical": { type: "string" },
    "structure-id": { type: "string" },
    "sd-id": { type: "string" },
    "structure-name": { type: "string" },
    "sd-name": { type: "string" },
    "structure-title": { type: "string" },
    "sd-title": { type: "string" },
    "structure-canonical": { type: "string" },
    "sd-canonical": { type: "string" },
    update: { type: "boolean", short: "u", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
  allowPositionals: false,
};

/**
 * Last-wins fold of a long flag and its short alias. Returns the
 * value that should be used (long takes precedence only when the short
 * is undefined; otherwise we use whichever was actually provided —
 * `parseArgs` doesn't tell us which one came last on the command line,
 * so when both are present we prefer the long form for determinism).
 *
 * Per the plan: "no dedicated alias-collision error is emitted because
 * the source request is silent on the case and last-wins is unambiguous
 * in practice."
 */
function fold(longVal: string | undefined, shortVal: string | undefined): string | undefined {
  if (longVal !== undefined) return longVal;
  return shortVal;
}

export function parseArgv(argv: readonly string[]): ParseResult {
  let raw: ReturnType<typeof parseArgs>;
  try {
    raw = parseArgs({ ...PARSE_CONFIG, args: argv as string[] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Detect a removed legacy flag: `parseArgs` strict mode rejects with
    // "Unknown option '--foo'" (or similar variants depending on bun
    // version). Substring-match the removed-flag names.
    for (const flag of Object.keys(REMOVED_FLAG_HINTS)) {
      if (msg.includes(`--${flag}`)) {
        return {
          error: `error: --${flag} ${REMOVED_FLAG_HINTS[flag]}`,
        };
      }
    }
    return { error: `error: ${msg}` };
  }

  const v = raw.values as Record<string, string | boolean | undefined>;

  const help = v.help === true;
  if (help) {
    return {
      operationIdCase: null,
      operationNameCase: null,
      operationTitleCase: null,
      operationCanonicalRefSync: false,
      structureIdCase: null,
      structureNameCase: null,
      structureTitleCase: null,
      structureCanonicalCase: null,
      update: false,
      help: true,
    };
  }

  // Fold long+short aliases.
  const opId = fold(v["operation-id"] as string | undefined, v["op-id"] as string | undefined);
  const opName = fold(v["operation-name"] as string | undefined, v["op-name"] as string | undefined);
  const opTitle = fold(v["operation-title"] as string | undefined, v["op-title"] as string | undefined);
  const opCanonical = fold(
    v["operation-canonical"] as string | undefined,
    v["op-canonical"] as string | undefined,
  );
  const sdId = fold(v["structure-id"] as string | undefined, v["sd-id"] as string | undefined);
  const sdName = fold(v["structure-name"] as string | undefined, v["sd-name"] as string | undefined);
  const sdTitle = fold(v["structure-title"] as string | undefined, v["sd-title"] as string | undefined);
  const sdCanonical = fold(
    v["structure-canonical"] as string | undefined,
    v["sd-canonical"] as string | undefined,
  );

  const update = v.update === true;

  let operationIdCase: Case | null = null;
  let operationNameCase: Case | null = null;
  let operationTitleCase: Case | null = null;
  let operationCanonicalRefSync = false;
  let structureIdCase: Case | null = null;
  let structureNameCase: Case | null = null;
  let structureTitleCase: Case | null = null;
  let structureCanonicalCase: Case | null = null;

  if (opId !== undefined) {
    const c = parseCaseName(opId, ALLOWED_ID_CASES);
    if (!c) {
      return {
        error: `error: --operation-id value '${opId}' is not allowed (use lower_snake or lower-kebab)`,
      };
    }
    operationIdCase = c;
  }
  if (opName !== undefined) {
    const c = parseCaseName(opName, ALLOWED_NAME_CASES);
    if (!c) {
      return {
        error: `error: --operation-name value '${opName}' is not allowed (use lower_snake, lower-kebab, Upper-Kebab, Title-Kebab, Pascal-Kebab, lowerCamel, or UpperPascal)`,
      };
    }
    operationNameCase = c;
  }
  if (opTitle !== undefined) {
    const c = parseCaseName(opTitle, ALLOWED_NAME_CASES);
    if (!c) {
      return {
        error: `error: --operation-title value '${opTitle}' is not allowed (use lower_snake, lower-kebab, Upper-Kebab, Title-Kebab, Pascal-Kebab, lowerCamel, or UpperPascal)`,
      };
    }
    operationTitleCase = c;
  }
  if (opCanonical !== undefined) {
    const sentinel = parseOpCanonicalSentinel(opCanonical);
    if (sentinel === null) {
      return {
        error: `error: --operation-canonical value '${opCanonical}' is not allowed (use one of: none, na, ref, #, #ref)`,
      };
    }
    operationCanonicalRefSync = sentinel;
  }
  if (sdId !== undefined) {
    const c = parseCaseName(sdId, ALLOWED_ID_CASES);
    if (!c) {
      return {
        error: `error: --structure-id value '${sdId}' is not allowed (use lower_snake or lower-kebab)`,
      };
    }
    structureIdCase = c;
  }
  if (sdName !== undefined) {
    const c = parseCaseName(sdName, ALLOWED_NAME_CASES);
    if (!c) {
      return {
        error: `error: --structure-name value '${sdName}' is not allowed (use lower_snake, lower-kebab, Upper-Kebab, Title-Kebab, Pascal-Kebab, lowerCamel, or UpperPascal)`,
      };
    }
    structureNameCase = c;
  }
  if (sdTitle !== undefined) {
    const c = parseCaseName(sdTitle, ALLOWED_NAME_CASES);
    if (!c) {
      return {
        error: `error: --structure-title value '${sdTitle}' is not allowed (use lower_snake, lower-kebab, Upper-Kebab, Title-Kebab, Pascal-Kebab, lowerCamel, or UpperPascal)`,
      };
    }
    structureTitleCase = c;
  }
  if (sdCanonical !== undefined) {
    const c = parseCaseName(sdCanonical, ALLOWED_SC_CASES);
    if (!c) {
      return {
        error: `error: --structure-canonical value '${sdCanonical}' is not allowed (use lower_snake, lower-kebab, Upper-Kebab, Title-Kebab, or Pascal-Kebab)`,
      };
    }
    structureCanonicalCase = c;
  }

  // "Nothing to do" rule: at least one matrix flag must be present.
  const hasMatrix =
    operationIdCase !== null ||
    operationNameCase !== null ||
    operationTitleCase !== null ||
    operationCanonicalRefSync ||
    structureIdCase !== null ||
    structureNameCase !== null ||
    structureTitleCase !== null ||
    structureCanonicalCase !== null;

  if (!hasMatrix) {
    if (update) {
      return {
        error: "error: --update without any matrix flag has nothing to do",
      };
    }
    return {
      error:
        "error: nothing to do; pass at least one matrix flag (--operation-id, --operation-name, --operation-title, --operation-canonical, --structure-id, --structure-name, --structure-title, --structure-canonical)",
    };
  }

  return {
    operationIdCase,
    operationNameCase,
    operationTitleCase,
    operationCanonicalRefSync,
    structureIdCase,
    structureNameCase,
    structureTitleCase,
    structureCanonicalCase,
    update,
    help: false,
  };
}
