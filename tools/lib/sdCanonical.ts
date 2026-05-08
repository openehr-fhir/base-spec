// --structure-canonical: discover every parent-SD canonical URL across
// input/resources/, then per-SD-file re-case the SD's own
// url/type/baseDefinition final segment AND every in-package reference
// whose key is in the rewrite-key allowlist AND whose full string value
// is in the discovered SD canonical set.
//
// Two-pass design:
//   Pass 1 (discoverSdCanonicals): one read per file, gather every
//     top-level url from files whose resourceType === "StructureDefinition".
//   Pass 2 (planSdCanonicalRewrite): per-SD-file, emit a sorted Edit[]
//     for that file's own canonical trio + cross-refs. Non-SD files
//     produce nothing.
//
// Per the request and rev-3 of the plan:
//   - No URL-prefix gate. Every SD in input/resources/ joins the set
//     regardless of url prefix; cross-ref safety is structural via
//     exact-string membership.
//   - Cross-ref rewrite-key allowlist is fixed:
//     {code, profile, targetProfile, valueCanonical, valueUrl}.
//   - Versioned canonicals (".../FOO|1.2.0") never match.
//   - Divergent url vs type → per-file error, zero edits emitted.
//   - All edits replace ONLY the final segment of the canonical URL.

import { findNodeAtLocation, type Edit, type Node } from "jsonc-parser";
import { format, tokenize, type Case } from "./casing.ts";
import type { ChangeRecord, PlannerOutput } from "./edits.ts";

const REWRITE_KEYS: ReadonlySet<string> = new Set([
  "code",
  "profile",
  "targetProfile",
  "valueCanonical",
  "valueUrl",
]);

export interface SdFileInput {
  relPath: string;
  source: string;
  root: Node;
}

export interface DiscoveryResult {
  /** Set of every discovered SD top-level url (exact string). */
  canonicals: Set<string>;
  /** Per-file errors encountered during discovery (none today; reserved). */
  errors: Array<{ relPath: string; message: string }>;
}

/**
 * Returns true when the parsed root is an object whose top-level
 * resourceType is exactly "StructureDefinition".
 */
export function isStructureDefinitionRoot(root: Node): boolean {
  if (root.type !== "object") return false;
  const rt = findNodeAtLocation(root, ["resourceType"]);
  return !!rt && rt.type === "string" && rt.value === "StructureDefinition";
}

/**
 * Pass 1: collect every top-level `url` from files whose root
 * resourceType is exactly "StructureDefinition". Files of any other
 * resourceType are skipped and never indexed.
 */
export function discoverSdCanonicals(
  files: Iterable<SdFileInput>,
): DiscoveryResult {
  const canonicals = new Set<string>();
  const errors: Array<{ relPath: string; message: string }> = [];
  for (const f of files) {
    if (!isStructureDefinitionRoot(f.root)) continue;
    const url = findNodeAtLocation(f.root, ["url"]);
    if (!url || url.type !== "string") continue;
    const value = String(url.value);
    if (value.length === 0) continue;
    canonicals.add(value);
  }
  return { canonicals, errors };
}

/**
 * Compute the byte-precise edit that replaces only the final segment
 * (after the last "/") of a string-literal value Node. Returns null
 * when the value contains no "/" (the caller decides whether that is
 * an error).
 */
function buildFinalSegmentEdit(
  valueNode: Node,
  newSegment: string,
): Edit | null {
  if (valueNode.type !== "string") return null;
  const value = String(valueNode.value);
  const lastSlash = value.lastIndexOf("/");
  if (lastSlash < 0) return null;
  // valueNode.offset is the opening `"`. The string content starts at
  // valueNode.offset + 1. Final-segment bytes start at
  //   valueNode.offset + 1 + lastSlash + 1.
  const segOffset = valueNode.offset + 1 + lastSlash + 1;
  const segLength = value.length - lastSlash - 1;
  return { offset: segOffset, length: segLength, content: newSegment };
}

function lastSegmentOf(url: string): string {
  const i = url.lastIndexOf("/");
  return i < 0 ? url : url.substring(i + 1);
}

function prefixOf(url: string): string {
  const i = url.lastIndexOf("/");
  return i < 0 ? "" : url.substring(0, i);
}

export interface PlanSdCanonicalInput {
  source: string;
  root: Node;
  /** SD canonical case to re-cast the final segment to. */
  targetCase: Case;
  /** Discovered SD canonical set (output of discoverSdCanonicals). */
  discovered: ReadonlySet<string>;
}

/**
 * Pass 2: emit edits for one SD file: the file's own
 * url/type/baseDefinition final-segment re-case AND every in-package
 * cross-ref whose key is in the rewrite allowlist AND whose full value
 * is in the discovered set.
 *
 * Files whose root is not a StructureDefinition return zero edits and
 * zero records (caller is expected to filter, but the function is
 * defensive).
 */
export function planSdCanonicalRewrite(
  input: PlanSdCanonicalInput,
): PlannerOutput {
  const { root, targetCase, discovered } = input;
  const edits: Edit[] = [];
  const records: ChangeRecord[] = [];
  const errors: string[] = [];

  if (!isStructureDefinitionRoot(root)) {
    return { edits, records, errors };
  }

  const urlNode = findNodeAtLocation(root, ["url"]);
  const typeNode = findNodeAtLocation(root, ["type"]);
  const baseNode = findNodeAtLocation(root, ["baseDefinition"]);

  const idNode = findNodeAtLocation(root, ["id"]);
  const sdId =
    idNode && idNode.type === "string" ? String(idNode.value) : null;
  // Row key for SD records: SD.id (preferred), else url's last segment, else "<sd>".
  const urlValue =
    urlNode && urlNode.type === "string" ? String(urlNode.value) : null;
  const rowKey = sdId ?? (urlValue ? lastSegmentOf(urlValue) : "<sd>");

  // Membership gate: if this SD's own url is not in the discovered set
  // (e.g. malformed/empty url), do nothing. This makes the "never
  // rewrite a string whose target canonical is not discovered"
  // guarantee structural.
  if (!urlValue || !discovered.has(urlValue)) {
    return { edits, records, errors };
  }

  // Compute the new final segment from the current one.
  const lastSlash = urlValue.lastIndexOf("/");
  if (lastSlash < 0) {
    errors.push(
      `StructureDefinition.url '${urlValue}' has no '/'; cannot derive a final segment to re-case`,
    );
    return { edits, records, errors };
  }
  const oldSegment = urlValue.substring(lastSlash + 1);
  const newSegment = format(tokenize(oldSegment), targetCase);

  // Divergent-url-vs-type check (must beat any rewrite emission).
  if (typeNode && typeNode.type === "string") {
    const typeValue = String(typeNode.value);
    const urlSeg = lastSegmentOf(urlValue);
    const typeSeg = lastSegmentOf(typeValue);
    const urlPrefix = prefixOf(urlValue);
    const typePrefix = prefixOf(typeValue);
    // type may be a bare segment (e.g. "Activity") with no prefix; we
    // only flag divergence when type is itself a URL (contains "/")
    // and either its prefix or its final segment differs from url's.
    const typeIsUrl = typeValue.includes("/");
    if (typeIsUrl) {
      if (urlSeg !== typeSeg || urlPrefix !== typePrefix) {
        errors.push(
          `url and type final segments differ; refusing to re-case ('${urlSeg}' vs '${typeSeg}')`,
        );
        return { edits, records, errors };
      }
    } else {
      // Bare-segment type: only flag if it disagrees with url's segment.
      if (typeSeg !== urlSeg) {
        errors.push(
          `url and type final segments differ; refusing to re-case ('${urlSeg}' vs '${typeSeg}')`,
        );
        return { edits, records, errors };
      }
    }
  }

  // SD's own url/type/baseDefinition (each only when present and only
  // when the segment actually changes).
  if (oldSegment !== newSegment) {
    if (urlNode && urlNode.type === "string") {
      const e = buildFinalSegmentEdit(urlNode, newSegment);
      if (e) {
        edits.push(e);
        records.push({
          opId: rowKey,
          field: "sd.url" as any,
          oldValue: urlValue,
          newValue: replaceLastSegment(urlValue, newSegment),
        });
      }
    }
    if (typeNode && typeNode.type === "string") {
      const tValue = String(typeNode.value);
      // When type is a bare segment with no '/', treat the entire value
      // as the segment to replace.
      if (tValue.includes("/")) {
        const e = buildFinalSegmentEdit(typeNode, newSegment);
        if (e) {
          edits.push(e);
          records.push({
            opId: rowKey,
            field: "sd.type" as any,
            oldValue: tValue,
            newValue: replaceLastSegment(tValue, newSegment),
          });
        }
      } else if (tValue === oldSegment) {
        // Bare-segment replace: replace the whole literal contents.
        edits.push({
          offset: typeNode.offset + 1,
          length: typeNode.length - 2,
          content: newSegment,
        });
        records.push({
          opId: rowKey,
          field: "sd.type" as any,
          oldValue: tValue,
          newValue: newSegment,
        });
      }
    }
  }

  // baseDefinition: only emit an edit if the FULL value is in the
  // discovered set. This naturally excludes HL7 base types like
  // ".../Element".
  if (baseNode && baseNode.type === "string") {
    const baseValue = String(baseNode.value);
    if (discovered.has(baseValue)) {
      const baseLast = baseValue.lastIndexOf("/");
      if (baseLast >= 0) {
        const baseOld = baseValue.substring(baseLast + 1);
        const baseNew = format(tokenize(baseOld), targetCase);
        if (baseOld !== baseNew) {
          const e = buildFinalSegmentEdit(baseNode, baseNew);
          if (e) {
            edits.push(e);
            records.push({
              opId: rowKey,
              field: "sd.baseDefinition" as any,
              oldValue: baseValue,
              newValue: replaceLastSegment(baseValue, baseNew),
            });
          }
        }
      }
    }
  }

  // Cross-ref walk: visit every property in the tree; when the key is
  // in the allowlist, handle either a string value (e.g. code,
  // valueCanonical, valueUrl) or an array-of-strings (e.g. profile,
  // targetProfile). For each string in `discovered`, emit a final-
  // segment edit.
  collectCrossRefEdits(root, [], discovered, targetCase, edits, records, rowKey);

  edits.sort((a, b) => a.offset - b.offset);
  return { edits, records, errors };
}

function replaceLastSegment(url: string, newSegment: string): string {
  const i = url.lastIndexOf("/");
  if (i < 0) return newSegment;
  return url.substring(0, i + 1) + newSegment;
}

/** Render a path[]+key into a stable, dotted-with-indices string. */
function renderPath(path: ReadonlyArray<string | number>, key: string): string {
  const segs: string[] = [];
  for (const p of path) {
    if (typeof p === "number") {
      // Append the index to the previous segment.
      const last = segs.pop();
      segs.push(`${last ?? ""}[${p}]`);
    } else {
      segs.push(p);
    }
  }
  segs.push(key);
  return segs.join(".");
}

/**
 * Walk the parsed JSON tree, emitting cross-ref edits whenever a
 * property whose key is in REWRITE_KEYS contains a string value (or
 * an array-of-strings) that exactly matches a discovered SD canonical.
 *
 * Path tracking: `path` is a sparse mix of string property names and
 * numeric array indices, e.g. ["differential", "element", 3, "type", 0].
 * `renderPath` collapses adjacent (segment, index) pairs to "name[i]".
 */
function collectCrossRefEdits(
  node: Node,
  path: ReadonlyArray<string | number>,
  discovered: ReadonlySet<string>,
  targetCase: Case,
  edits: Edit[],
  records: ChangeRecord[],
  rowKey: string,
): void {
  if (!node) return;
  if (node.type === "object") {
    for (const prop of node.children ?? []) {
      if (prop.type !== "property") continue;
      const keyNode = prop.children?.[0];
      const valueNode = prop.children?.[1];
      if (!keyNode || keyNode.type !== "string" || !valueNode) continue;
      const key = String(keyNode.value);

      // Handle allowlisted keys at this node.
      if (REWRITE_KEYS.has(key)) {
        if (valueNode.type === "string") {
          tryEmitCrossRefEdit(
            valueNode,
            String(valueNode.value),
            renderPath(path, key),
            discovered,
            targetCase,
            edits,
            records,
            rowKey,
          );
        } else if (valueNode.type === "array") {
          const items = valueNode.children ?? [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i]!;
            if (item.type !== "string") continue;
            tryEmitCrossRefEdit(
              item,
              String(item.value),
              renderPath(path, `${key}[${i}]`),
              discovered,
              targetCase,
              edits,
              records,
              rowKey,
            );
          }
        }
      }

      // Recurse into objects/arrays for further refs.
      if (valueNode.type === "object" || valueNode.type === "array") {
        collectCrossRefEdits(
          valueNode,
          [...path, key],
          discovered,
          targetCase,
          edits,
          records,
          rowKey,
        );
      }
    }
  } else if (node.type === "array") {
    const items = node.children ?? [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.type === "object" || item.type === "array") {
        collectCrossRefEdits(
          item,
          [...path, i],
          discovered,
          targetCase,
          edits,
          records,
          rowKey,
        );
      }
    }
  }
}

function tryEmitCrossRefEdit(
  valueNode: Node,
  value: string,
  pathString: string,
  discovered: ReadonlySet<string>,
  targetCase: Case,
  edits: Edit[],
  records: ChangeRecord[],
  rowKey: string,
): void {
  if (!discovered.has(value)) return;
  const li = value.lastIndexOf("/");
  if (li < 0) return;
  const oldSeg = value.substring(li + 1);
  const newSeg = format(tokenize(oldSeg), targetCase);
  if (oldSeg === newSeg) return;
  const edit = buildFinalSegmentEdit(valueNode, newSeg);
  if (!edit) return;
  edits.push(edit);
  records.push({
    opId: rowKey,
    field: pathString as any,
    oldValue: value,
    newValue: replaceLastSegment(value, newSeg),
  });
}
