// Pure casing helpers: tokenize an identifier into lower-case word
// tokens, format a token sequence into one of the supported cases, and
// parse user-supplied case names (with aliases) from the CLI.

export type Case =
  | "lower_snake"
  | "lower-kebab"
  | "Upper-Kebab"
  | "Title-Kebab"
  | "Pascal-Kebab"
  | "lowerCamel"
  | "UpperPascal";

const ID_CASES: readonly Case[] = ["lower_snake", "lower-kebab"];
const NAME_CASES: readonly Case[] = [
  "lower_snake",
  "lower-kebab",
  "Upper-Kebab",
  "Title-Kebab",
  "Pascal-Kebab",
  "lowerCamel",
  "UpperPascal",
];
const SC_CASES: readonly Case[] = [
  "lower_snake",
  "lower-kebab",
  "Upper-Kebab",
  "Title-Kebab",
  "Pascal-Kebab",
];

export const ALLOWED_ID_CASES: readonly Case[] = ID_CASES;
export const ALLOWED_NAME_CASES: readonly Case[] = NAME_CASES;
export const ALLOWED_SC_CASES: readonly Case[] = SC_CASES;

const ALIASES: Readonly<Record<string, Case>> = {
  // canonical
  lower_snake: "lower_snake",
  "lower-kebab": "lower-kebab",
  "upper-kebab": "Upper-Kebab",
  "title-kebab": "Title-Kebab",
  "pascal-kebab": "Pascal-Kebab",
  lowercamel: "lowerCamel",
  upperpascal: "UpperPascal",
  // aliases (compared case-insensitively)
  "lower-hyphen": "lower-kebab",
  "lower-dash": "lower-kebab",
  "upper-hyphen": "Upper-Kebab",
  "upper-dash": "Upper-Kebab",
  "title-hyphen": "Title-Kebab",
  "title-dash": "Title-Kebab",
  "pascal-hyphen": "Pascal-Kebab",
  "pascal-dash": "Pascal-Kebab",
  camel: "lowerCamel",
  pascal: "UpperPascal",
};

/**
 * Resolve a user-supplied case name (case-insensitive on the value) to
 * a canonical Case, or return null if it is not allowed for the given
 * field. The `allowed` argument restricts the set (e.g. id only
 * accepts the two lower cases).
 */
export function parseCaseName(
  input: string,
  allowed: readonly Case[],
): Case | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const c = ALIASES[input.toLowerCase()];
  if (!c) return null;
  return allowed.includes(c) ? c : null;
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
 */
export function format(tokens: readonly string[], c: Case): string {
  if (tokens.length === 0) return "";
  switch (c) {
    case "lower_snake":
      return tokens.map((t) => t.toLowerCase()).join("_");
    case "lower-kebab":
      return tokens.map((t) => t.toLowerCase()).join("-");
    case "Upper-Kebab":
      return tokens.map((t) => t.toUpperCase()).join("-");
    case "Title-Kebab":
    case "Pascal-Kebab":
      return tokens.map((t) => capitalize(t.toLowerCase())).join("-");
    case "lowerCamel":
      return (
        tokens[0]!.toLowerCase() +
        tokens
          .slice(1)
          .map((t) => capitalize(t.toLowerCase()))
          .join("")
      );
    case "UpperPascal":
      return tokens.map((t) => capitalize(t.toLowerCase())).join("");
  }
}
