// Pure casing helpers: tokenize an identifier into lower-case word
// tokens, format a token sequence into one of the supported cases, and
// parse user-supplied case names from the CLI.
//
// The 8 canonical case names are unified across every case-taking flag.
// Input parsing is case-insensitive and treats `-` and `_` as
// interchangeable separators.

export type Case =
  | "lower_snake"
  | "lower-kebab"
  | "Title_Snake"
  | "Title-Kebab"
  | "UPPER_SNAKE"
  | "UPPER-KEBAB"
  | "camel"
  | "Pascal";

/**
 * Every case-taking matrix flag accepts the same 8-name allowlist.
 */
export const ALLOWED_CASES: readonly Case[] = [
  "lower_snake",
  "lower-kebab",
  "Title_Snake",
  "Title-Kebab",
  "UPPER_SNAKE",
  "UPPER-KEBAB",
  "camel",
  "Pascal",
];

/**
 * Returns true for the three cases whose canonical name contains `_`.
 * Used by the runWith id-flag warning path: FHIR `id` values forbid
 * `_`, so a chosen id case carrying `_` is worth a one-line stderr
 * warning. Defined here so the canonical-name source-of-truth lives
 * next to the `Case` union.
 */
export function caseHasUnderscore(c: Case): boolean {
  return c === "lower_snake" || c === "Title_Snake" || c === "UPPER_SNAKE";
}

/**
 * Resolve a user-supplied case name to a canonical Case, or return
 * null if it is not recognized.
 *
 * Parser rules:
 * - Input is case-insensitive (the canonical chosen depends on the
 *   *family* keyword, not on the input casing — except in the
 *   single-token camel/Pascal branch, see below).
 * - `-` and `_` are interchangeable separators (e.g. `lower_kebab`,
 *   `lower-kebab`, and `LOWER-KEBAB` all resolve to `"lower-kebab"`).
 * - Multi-token form is `<family>(-|_)<shape>`:
 *     family ∈ {lower, title, upper, pascal} (pascal is a synonym for
 *              title in this position)
 *     shape  ∈ {snake, kebab}
 *   The shape keyword forces the separator in the canonical name
 *   regardless of which separator the caller used.
 * - Single-token form: `camel` and `pascal` are the only legal
 *   inputs. The chosen canonical depends on the *first character of
 *   the original input* — uppercase first char picks `"Pascal"`,
 *   anything else picks `"camel"`. Hence `parseCaseName("pascal")`
 *   returns `"camel"` and `parseCaseName("CAMEL")` returns `"Pascal"`;
 *   this is mildly counterintuitive but follows from the rule.
 * - Anything else returns null.
 */
export function parseCaseName(input: string): Case | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const lower = input.toLowerCase();

  // Single-token branch: only `camel` and `pascal` are legal.
  if (!lower.includes("-") && !lower.includes("_")) {
    if (lower === "camel" || lower === "pascal") {
      const first = input[0]!;
      const isUpperFirst = first >= "A" && first <= "Z";
      return isUpperFirst ? "Pascal" : "camel";
    }
    return null;
  }

  // Multi-token branch: split on either separator; require exactly
  // 2 non-empty parts.
  const parts = lower.split(/[-_]/);
  if (parts.length !== 2) return null;
  const family = parts[0]!;
  const shape = parts[1]!;
  if (family.length === 0 || shape.length === 0) return null;

  const isFamily = family === "lower" || family === "title" || family === "upper" || family === "pascal";
  const isShape = shape === "snake" || shape === "kebab";
  if (!isFamily || !isShape) return null;

  if (family === "lower") {
    return shape === "snake" ? "lower_snake" : "lower-kebab";
  }
  if (family === "title" || family === "pascal") {
    return shape === "snake" ? "Title_Snake" : "Title-Kebab";
  }
  // family === "upper"
  return shape === "snake" ? "UPPER_SNAKE" : "UPPER-KEBAB";
}

/**
 * Split an identifier into lower-case word tokens. Splits on `_`, `-`,
 * and case-boundary transitions. Empty input yields an empty array.
 *
 *   "is_strictly_comparable_to" -> ["is","strictly","comparable","to"]
 *   "IsStrictlyComparableTo"    -> ["is","strictly","comparable","to"]
 *   "magnitude"                 -> ["magnitude"]
 */
export function tokenize(input: string): string[] {
  if (!input) return [];
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push(buf.toLowerCase());
      buf = "";
    }
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "_" || ch === "-" || ch === " ") {
      flush();
      continue;
    }
    const isUpper = ch >= "A" && ch <= "Z";
    if (isUpper && buf.length > 0) {
      const prev = buf[buf.length - 1]!;
      const prevIsLower = prev >= "a" && prev <= "z";
      const prevIsDigit = prev >= "0" && prev <= "9";
      if (prevIsLower || prevIsDigit) {
        // lower|digit -> Upper boundary: split (e.g. "isStrictly" -> is | Strictly)
        flush();
      } else if (i + 1 < input.length) {
        // Upper followed by lower while in an Upper run: split before this Upper
        // (e.g. "HTTPRequest" -> HTTP | Request)
        const next = input[i + 1]!;
        if (next >= "a" && next <= "z") flush();
      }
    }
    buf += ch;
  }
  flush();
  return out;
}

function capitalize(token: string): string {
  if (!token) return token;
  return token[0]!.toUpperCase() + token.slice(1);
}

/**
 * Render a token sequence in the requested case. An empty token list
 * renders as the empty string regardless of case.
 *
 * `tokenize` always lowercases its emitted tokens; `format` therefore
 * applies the natural per-token rule for each canonical case (lowercase
 * tokens, then snake/kebab/UPPERCASE/Title/Pascal/camel shaping). When
 * callers pass mixed- or all-caps tokens directly to `format` (without
 * going through `tokenize`), every case still re-normalizes per-token
 * before applying the shape — there is no all-caps preservation rule.
 */
export function format(tokens: readonly string[], c: Case): string {
  if (tokens.length === 0) return "";
  switch (c) {
    case "lower_snake":
      return tokens.map((t) => t.toLowerCase()).join("_");
    case "lower-kebab":
      return tokens.map((t) => t.toLowerCase()).join("-");
    case "UPPER_SNAKE":
      return tokens.map((t) => t.toUpperCase()).join("_");
    case "UPPER-KEBAB":
      return tokens.map((t) => t.toUpperCase()).join("-");
    case "Title_Snake":
      return tokens.map((t) => capitalize(t.toLowerCase())).join("_");
    case "Title-Kebab":
      return tokens.map((t) => capitalize(t.toLowerCase())).join("-");
    case "Pascal":
      return tokens.map((t) => capitalize(t.toLowerCase())).join("");
    case "camel":
      return (
        tokens[0]!.toLowerCase() +
        tokens
          .slice(1)
          .map((t) => capitalize(t.toLowerCase()))
          .join("")
      );
  }
}
