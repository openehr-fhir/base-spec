// --repair mode: rewrite each root type-operation valueCanonical
// fragment to match the *current* OperationDefinition.id it
// semantically refers to. The OpDef.id is the source of truth; the
// fragment is matched by tokenizing both sides and comparing the token
// sequences for equality.

import type { Edit, Node } from "jsonc-parser";
import { tokenize } from "./casing.ts";
import {
  collectOpDefs,
  collectTypeOpExtensions,
  type ChangeRecord,
  type PlannerOutput,
} from "./edits.ts";

interface OpDefIdSite {
  id: string;
  tokens: string[];
}

export interface RepairInput {
  source: string;
  root: Node;
}

export type ResolveResult =
  | { kind: "match"; id: string }
  | { kind: "none" }
  | { kind: "ambiguous"; ids: string[] };

/**
 * Resolve a fragment-id to a single OperationDefinition.id by
 * tokenizing both sides and comparing token sequences for equality.
 */
export function resolveRefByTokens(
  refId: string,
  opDefIds: readonly string[],
): ResolveResult {
  const refTokens = tokenize(refId);
  const matches: string[] = [];
  for (const id of opDefIds) {
    const idTokens = tokenize(id);
    if (
      idTokens.length === refTokens.length &&
      idTokens.every((t, i) => t === refTokens[i])
    ) {
      matches.push(id);
    }
  }
  if (matches.length === 1) return { kind: "match", id: matches[0]! };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", ids: matches };
}

export function planRepair(input: RepairInput): PlannerOutput {
  const { root } = input;
  const edits: Edit[] = [];
  const records: ChangeRecord[] = [];
  const errors: string[] = [];

  const opDefs = collectOpDefs(root);
  const opDefIdSites: OpDefIdSite[] = [];
  for (const od of opDefs) {
    if (od.originalId === null) continue;
    opDefIdSites.push({ id: od.originalId, tokens: tokenize(od.originalId) });
  }
  const opDefIds = opDefIdSites.map((s) => s.id);

  const exts = collectTypeOpExtensions(root);
  for (const e of exts) {
    const result = resolveRefByTokens(e.fragment, opDefIds);
    if (result.kind === "none") {
      errors.push(
        `type-operation valueCanonical '#${e.fragment}' does not resolve to any contained OperationDefinition.id`,
      );
      continue;
    }
    if (result.kind === "ambiguous") {
      errors.push(
        `type-operation valueCanonical '#${e.fragment}' is ambiguous; matches multiple OperationDefinition.id values: ${result.ids.join(", ")}`,
      );
      continue;
    }
    if (result.id === e.fragment) continue; // already in sync
    // Build a value-replacement edit for the bytes between the quotes.
    edits.push({
      offset: e.valueNode.offset + 1,
      length: e.valueNode.length - 2,
      content: `#${result.id}`,
    });
    records.push({
      opId: result.id,
      field: "valueCanonical",
      oldValue: `#${e.fragment}`,
      newValue: `#${result.id}`,
    });
  }

  edits.sort((a, b) => a.offset - b.offset);
  return { edits, records, errors };
}
