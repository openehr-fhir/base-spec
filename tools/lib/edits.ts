// JSON-tree walking + edit construction for the case-changing pipeline.
//
// All public helpers here are pure: they take a parsed file and a
// ParsedArgs-like config and return Edit[] + ChangeRecord[] + error[]
// arrays. The CLI driver in changeTypeFunctionCasing.ts is responsible
// for invoking jsonc-parser.applyEdits and any I/O.

import {
  findNodeAtLocation,
  type Edit,
  type Node,
} from "jsonc-parser";
import { format, tokenize, type Case } from "./casing.ts";

export type FieldName = "id" | "name" | "title";
export type SdFieldName = "sd.id" | "sd.name" | "sd.title";

export interface ChangeRecord {
  /**
   * Row key for the report line. For OpDef-rooted records this is the
   * (pre-rename) OperationDefinition.id. For SD-rooted records this is
   * the (pre-rename) StructureDefinition.id (or the file's basename
   * fallback when the SD has no id).
   */
  opId: string;
  /** Field discriminator. SD records use the "sd." prefix internally. */
  field: FieldName | SdFieldName | "valueCanonical";
  /** Original value, or null when this is an inserted property. */
  oldValue: string | null;
  /** New value (without surrounding quotes; for valueCanonical includes the leading "#"). */
  newValue: string;
}

export interface PlannerInput {
  source: string;
  root: Node;
  /** Operation-side (contained OpDef) per-field cases. */
  idCase: Case | null;
  nameCase: Case | null;
  titleCase: Case | null;
  /** Structure-side (parent StructureDefinition) per-field cases. */
  structureIdCase?: Case | null;
  structureNameCase?: Case | null;
  structureTitleCase?: Case | null;
}

export interface PlannerOutput {
  edits: Edit[];
  records: ChangeRecord[];
  errors: string[];
}

interface OpDefSite {
  /** OpDef object node. */
  obj: Node;
  /** Property nodes for the four fields we care about (when present). */
  props: Partial<Record<FieldName | "code", Node>>;
  /** Original id text (unchanged copy of the JSON value). */
  originalId: string | null;
  originalCode: string | null;
  originalName: string | null;
  originalTitle: string | null;
}

interface SdSite {
  /** Root SD object node. */
  obj: Node;
  /** Property nodes for SD top-level id/name/title (when present). */
  props: Partial<Record<FieldName, Node>>;
  originalId: string | null;
  originalName: string | null;
  originalTitle: string | null;
}

interface ExtSite {
  /** The valueCanonical string-literal value Node. */
  valueNode: Node;
  /** Fragment id without the leading "#". */
  fragment: string;
}

/**
 * Walks contained[] and returns one OpDefSite per contained
 * OperationDefinition. Items in contained[] that are not OpDefs are
 * skipped silently.
 */
export function collectOpDefs(root: Node): OpDefSite[] {
  const contained = findNodeAtLocation(root, ["contained"]);
  if (!contained || contained.type !== "array" || !contained.children) return [];
  const out: OpDefSite[] = [];
  for (const item of contained.children) {
    if (item.type !== "object") continue;
    const rt = findNodeAtLocation(item, ["resourceType"]);
    if (!rt || rt.type !== "string" || rt.value !== "OperationDefinition") continue;

    const props: OpDefSite["props"] = {};
    let originalId: string | null = null;
    let originalCode: string | null = null;
    let originalName: string | null = null;
    let originalTitle: string | null = null;

    for (const prop of item.children ?? []) {
      if (prop.type !== "property") continue;
      const key = prop.children?.[0]?.value;
      const valueNode = prop.children?.[1];
      if (typeof key !== "string" || !valueNode) continue;
      switch (key) {
        case "id":
          if (valueNode.type === "string") {
            props.id = prop;
            originalId = String(valueNode.value);
          }
          break;
        case "name":
          if (valueNode.type === "string") {
            props.name = prop;
            originalName = String(valueNode.value);
          }
          break;
        case "title":
          if (valueNode.type === "string") {
            props.title = prop;
            originalTitle = String(valueNode.value);
          }
          break;
        case "code":
          if (valueNode.type === "string") {
            props.code = prop;
            originalCode = String(valueNode.value);
          }
          break;
      }
    }
    out.push({
      obj: item,
      props,
      originalId,
      originalCode,
      originalName,
      originalTitle,
    });
  }
  return out;
}

/**
 * Capture the parent StructureDefinition's top-level id/name/title
 * property nodes, when the root resource is a StructureDefinition.
 * Returns null if the root is missing, not an object, or not a
 * StructureDefinition.
 *
 * NOTE: assumes at most one StructureDefinition per file (true for all
 * files under input/resources/ today). If a future file ever bundled
 * multiple SDs, only the file-root SD would be considered.
 */
export function collectSdSite(root: Node): SdSite | null {
  if (root.type !== "object") return null;
  const rt = findNodeAtLocation(root, ["resourceType"]);
  if (!rt || rt.type !== "string" || rt.value !== "StructureDefinition") {
    return null;
  }
  const props: SdSite["props"] = {};
  let originalId: string | null = null;
  let originalName: string | null = null;
  let originalTitle: string | null = null;
  for (const prop of root.children ?? []) {
    if (prop.type !== "property") continue;
    const key = prop.children?.[0]?.value;
    const valueNode = prop.children?.[1];
    if (typeof key !== "string" || !valueNode) continue;
    switch (key) {
      case "id":
        if (valueNode.type === "string") {
          props.id = prop;
          originalId = String(valueNode.value);
        }
        break;
      case "name":
        if (valueNode.type === "string") {
          props.name = prop;
          originalName = String(valueNode.value);
        }
        break;
      case "title":
        if (valueNode.type === "string") {
          props.title = prop;
          originalTitle = String(valueNode.value);
        }
        break;
    }
  }
  return { obj: root, props, originalId, originalName, originalTitle };
}

/**
 * Walks the parent resource's root extension[] array only. Returns one
 * ExtSite per extension whose url is the type-operation URL and whose
 * valueCanonical payload is a local fragment ("#…").
 */
export function collectTypeOpExtensions(root: Node): ExtSite[] {
  const ext = findNodeAtLocation(root, ["extension"]);
  if (!ext || ext.type !== "array" || !ext.children) return [];
  const out: ExtSite[] = [];
  const TYPE_OP_URL =
    "http://hl7.org/fhir/tools/StructureDefinition/type-operation";
  for (const item of ext.children) {
    if (item.type !== "object") continue;
    const url = findNodeAtLocation(item, ["url"]);
    if (!url || url.type !== "string" || url.value !== TYPE_OP_URL) continue;
    const v = findNodeAtLocation(item, ["valueCanonical"]);
    if (!v || v.type !== "string") continue;
    const s = String(v.value);
    if (!s.startsWith("#")) continue;
    out.push({ valueNode: v, fragment: s.slice(1) });
  }
  return out;
}

/** Tokens for an OpDef, derived from code (preferred) → id → name → title. */
function tokensForOpDef(site: OpDefSite): string[] | null {
  const sources = [
    site.originalCode,
    site.originalId,
    site.originalName,
    site.originalTitle,
  ];
  for (const s of sources) {
    if (s === null) continue;
    const t = tokenize(s);
    if (t.length > 0) return t;
  }
  return null;
}

/**
 * Builds a value-replacement Edit that swaps the bytes between the
 * opening and closing quote of a string-literal Node. The quotes
 * themselves and any whitespace outside them are preserved exactly.
 *
 * Note: this only emits a JSON-safe replacement when the new text
 * contains no characters that need escaping (`"`, `\`, control chars).
 * All openEHR identifiers are plain ASCII, so this is safe in practice;
 * the planner additionally guards against unsafe new values.
 */
function buildStringValueEdit(valueNode: Node, newText: string): Edit {
  if (valueNode.type !== "string") {
    throw new Error("buildStringValueEdit called on non-string node");
  }
  // valueNode.offset points at the opening `"`. Skip it; replace the
  // length-2 byte range that holds the string content; preserve the
  // closing `"`.
  return {
    offset: valueNode.offset + 1,
    length: valueNode.length - 2,
    content: newText,
  };
}

function isJsonSafeIdentifier(s: string): boolean {
  // openEHR identifiers are plain ASCII letters, digits, _, and -.
  // Anything else → reject; we never want to emit an escape.
  return /^[A-Za-z0-9_-]+$/.test(s);
}

/**
 * Compute the new id/name/title for an OpDef given the requested
 * cases, returning null for any field whose case is null.
 */
function computeTargets(
  site: OpDefSite,
  tokens: string[],
  args: { idCase: Case | null; nameCase: Case | null; titleCase: Case | null },
): { id: string | null; name: string | null; title: string | null } {
  return {
    id: args.idCase ? format(tokens, args.idCase) : null,
    name: args.nameCase ? format(tokens, args.nameCase) : null,
    title: args.titleCase ? format(tokens, args.titleCase) : null,
  };
}

/**
 * For a JSON object that needs a new "title" property inserted, build
 * the insertion Edit. The text is `,<EOL><indent>"title" : "<v>"`,
 * where:
 *   - `<EOL>` is the EOL style of the line *preceding* the chosen
 *     anchor sibling (CRLF or LF; falls back to "\n").
 *   - `<indent>` is the run of spaces / tabs at the start of the
 *     anchor sibling's line.
 *   - The `:` separator copies the bytes between the anchor's key
 *     and value (typically " : " in the IG-publisher style).
 *
 * Anchor preference: the existing `name` property → `id` → first
 * property in the host object.
 *
 * Returns null when the host object is empty (nothing to anchor on);
 * callers should treat this as an internal error and skip the file.
 *
 * Generic site interface: any host that exposes `obj` (the object
 * Node) and `props` (a record possibly containing `id`/`name` property
 * Nodes) works. Both OpDef and SD planners use this.
 */
function buildTitleInsertionEdit(
  source: string,
  site: { obj: Node; props: { id?: Node; name?: Node } },
  newTitle: string,
): Edit | null {
  const anchor = site.props.name ?? site.props.id ?? firstPropertyOf(site.obj);
  if (!anchor || anchor.type !== "property" || !anchor.children) return null;
  const keyNode = anchor.children[0]!;
  const valueNode = anchor.children[1]!;

  // Indent: the bytes from the start of the anchor's line up to the
  // first non-whitespace character (which is the key's opening `"`).
  const lineStart = lineStartOffset(source, keyNode.offset);
  const indent = source.substring(lineStart, keyNode.offset);

  // EOL: the line break(s) immediately before the anchor's line.
  const eol = detectEol(source, lineStart);

  // Separator between key and value (e.g. " : ").
  const sepStart = keyNode.offset + keyNode.length;
  const sepEnd = valueNode.offset;
  const sep = source.substring(sepStart, sepEnd);

  // Insert immediately after the anchor property's last byte. The
  // existing comma (if any) is *after* this property, so we always
  // need to inject a leading comma.
  const insertOffset = anchor.offset + anchor.length;
  const content = `,${eol}${indent}"title"${sep}"${newTitle}"`;

  return { offset: insertOffset, length: 0, content };
}

function firstPropertyOf(obj: Node): Node | undefined {
  if (obj.type !== "object" || !obj.children) return undefined;
  return obj.children.find((c) => c.type === "property");
}

function lineStartOffset(source: string, at: number): number {
  // Walk backwards to the byte after the last \n (or to 0).
  let i = at;
  while (i > 0 && source[i - 1] !== "\n") i--;
  return i;
}

function detectEol(source: string, lineStart: number): string {
  // Look at the bytes immediately preceding `lineStart`. lineStart - 1
  // is the \n; if the character before that is \r, the file uses CRLF.
  if (lineStart === 0) {
    // Fall back to scanning forward for the next line break.
    const lf = source.indexOf("\n", 0);
    if (lf > 0 && source[lf - 1] === "\r") return "\r\n";
    return "\n";
  }
  const prev = source[lineStart - 2];
  return prev === "\r" ? "\r\n" : "\n";
}

/**
 * Plan id/name/title changes for the parent StructureDefinition.
 * Mirrors the per-OpDef id/name/title logic in planCaseChanges, but
 * for the SD's top-level fields. Returns zero edits and zero records
 * when no SD-side cases are requested or when the file root is not a
 * StructureDefinition.
 *
 * Token derivation order: SD `id` → `name` → `title` (no `code` at SD
 * level — code is OpDef-only). If none of the three are present and
 * any SD-side case is requested, an error is recorded.
 */
export function applySdFieldEdits(
  source: string,
  root: Node,
  sdIdCase: Case | null,
  sdNameCase: Case | null,
  sdTitleCase: Case | null,
): PlannerOutput {
  const edits: Edit[] = [];
  const records: ChangeRecord[] = [];
  const errors: string[] = [];

  if (sdIdCase === null && sdNameCase === null && sdTitleCase === null) {
    return { edits, records, errors };
  }

  const site = collectSdSite(root);
  if (!site) {
    // Root resource is not a StructureDefinition; SD-side flags are a
    // no-op for this file.
    return { edits, records, errors };
  }

  // Tokens: id → name → title (no `code` at SD level).
  const sources = [site.originalId, site.originalName, site.originalTitle];
  let tokens: string[] | null = null;
  for (const s of sources) {
    if (s === null) continue;
    const t = tokenize(s);
    if (t.length > 0) {
      tokens = t;
      break;
    }
  }
  if (!tokens) {
    errors.push(
      "StructureDefinition has no usable id/name/title to derive tokens from",
    );
    return { edits, records, errors };
  }

  const rowKey = site.originalId ?? site.originalName ?? "<unknown-sd>";

  const newId = sdIdCase !== null ? format(tokens, sdIdCase) : null;
  const newName = sdNameCase !== null ? format(tokens, sdNameCase) : null;
  const newTitle = sdTitleCase !== null ? format(tokens, sdTitleCase) : null;

  // SD.id
  if (newId !== null && site.originalId !== null && newId !== site.originalId) {
    if (!isJsonSafeIdentifier(newId)) {
      errors.push(
        `computed StructureDefinition.id '${newId}' contains characters that would require escaping`,
      );
    } else {
      const idValue = site.props.id!.children![1]!;
      edits.push(buildStringValueEdit(idValue, newId));
      records.push({
        opId: rowKey,
        field: "sd.id",
        oldValue: site.originalId,
        newValue: newId,
      });
    }
  }

  // SD.name
  if (newName !== null && site.originalName !== null && newName !== site.originalName) {
    if (!isJsonSafeIdentifier(newName)) {
      errors.push(
        `computed StructureDefinition.name '${newName}' contains characters that would require escaping`,
      );
    } else {
      const nameValue = site.props.name!.children![1]!;
      edits.push(buildStringValueEdit(nameValue, newName));
      records.push({
        opId: rowKey,
        field: "sd.name",
        oldValue: site.originalName,
        newValue: newName,
      });
    }
  }

  // SD.title (replace existing or insert).
  if (newTitle !== null) {
    if (site.originalTitle !== null) {
      if (newTitle !== site.originalTitle) {
        if (!isJsonSafeIdentifier(newTitle)) {
          errors.push(
            `computed StructureDefinition.title '${newTitle}' contains characters that would require escaping`,
          );
        } else {
          const titleValue = site.props.title!.children![1]!;
          edits.push(buildStringValueEdit(titleValue, newTitle));
          records.push({
            opId: rowKey,
            field: "sd.title",
            oldValue: site.originalTitle,
            newValue: newTitle,
          });
        }
      }
    } else {
      if (!isJsonSafeIdentifier(newTitle)) {
        errors.push(
          `computed StructureDefinition.title '${newTitle}' contains characters that would require escaping`,
        );
      } else {
        const insert = buildTitleInsertionEdit(source, site, newTitle);
        if (!insert) {
          errors.push(
            `cannot insert title for StructureDefinition '${rowKey}' (no anchor property)`,
          );
        } else {
          edits.push(insert);
          records.push({
            opId: rowKey,
            field: "sd.title",
            oldValue: null,
            newValue: newTitle,
          });
        }
      }
    }
  }

  return { edits, records, errors };
}

/**
 * Plan id/name/title changes (and the matching root extension
 * valueCanonical rewrites) for one parsed file.
 */
export function planCaseChanges(input: PlannerInput): PlannerOutput {
  const {
    source,
    root,
    idCase,
    nameCase,
    titleCase,
    structureIdCase = null,
    structureNameCase = null,
    structureTitleCase = null,
  } = input;
  const edits: Edit[] = [];
  const records: ChangeRecord[] = [];
  const errors: string[] = [];

  // Operation-side: re-case contained OpDefs.
  const opDefs = collectOpDefs(root);
  if (opDefs.length > 0) {
    const opOut = planOpDefCaseChanges(source, root, opDefs, idCase, nameCase, titleCase);
    edits.push(...opOut.edits);
    records.push(...opOut.records);
    errors.push(...opOut.errors);
  }

  // Structure-side: re-case the parent SD's id/name/title.
  const sdOut = applySdFieldEdits(
    source,
    root,
    structureIdCase,
    structureNameCase,
    structureTitleCase,
  );
  edits.push(...sdOut.edits);
  records.push(...sdOut.records);
  errors.push(...sdOut.errors);

  // Stable order: sort edits by offset for predictable apply.
  edits.sort((a, b) => a.offset - b.offset);

  return { edits, records, errors };
}

function planOpDefCaseChanges(
  source: string,
  root: Node,
  opDefs: OpDefSite[],
  idCase: Case | null,
  nameCase: Case | null,
  titleCase: Case | null,
): PlannerOutput {
  const edits: Edit[] = [];
  const records: ChangeRecord[] = [];
  const errors: string[] = [];

  // First pass: tokenize and compute targets, capturing old→new id map
  // for the extension rewrite step.
  type Plan = {
    site: OpDefSite;
    tokens: string[];
    target: { id: string | null; name: string | null; title: string | null };
    rowKey: string; // pre-change OpDef.id (or originalCode/originalName fallback)
  };
  const plans: Plan[] = [];

  for (const site of opDefs) {
    const tokens = tokensForOpDef(site);
    if (!tokens) {
      errors.push(
        "OperationDefinition has no usable id/name/title/code to derive tokens from",
      );
      continue;
    }
    const target = computeTargets(site, tokens, { idCase, nameCase, titleCase });

    const rowKey =
      site.originalId ?? site.originalCode ?? site.originalName ?? "<unknown>";

    plans.push({ site, tokens, target, rowKey });
  }

  // Detect duplicate ids after re-casing.
  const seenIds = new Map<string, string>(); // newId -> rowKey
  for (const p of plans) {
    const newId = p.target.id ?? p.site.originalId;
    if (newId === null) continue;
    if (seenIds.has(newId)) {
      errors.push(
        `duplicate OperationDefinition.id '${newId}' after re-casing (from '${seenIds.get(newId)}' and '${p.rowKey}')`,
      );
    } else {
      seenIds.set(newId, p.rowKey);
    }
  }

  // Build the id-rename map for extension rewrites.
  const idRenames = new Map<string, string>(); // oldId -> newId
  for (const p of plans) {
    if (p.target.id !== null && p.site.originalId !== null && p.target.id !== p.site.originalId) {
      idRenames.set(p.site.originalId, p.target.id);
    }
  }

  // Second pass: emit value-replacement edits and change records.
  for (const p of plans) {
    const { site, target, rowKey } = p;

    // id
    if (target.id !== null && site.originalId !== null && target.id !== site.originalId) {
      if (!isJsonSafeIdentifier(target.id)) {
        errors.push(`computed id '${target.id}' contains characters that would require escaping`);
      } else {
        const idValue = site.props.id!.children![1]!;
        edits.push(buildStringValueEdit(idValue, target.id));
        records.push({ opId: rowKey, field: "id", oldValue: site.originalId, newValue: target.id });
      }
    }

    // name
    if (target.name !== null && site.originalName !== null && target.name !== site.originalName) {
      if (!isJsonSafeIdentifier(target.name)) {
        errors.push(`computed name '${target.name}' contains characters that would require escaping`);
      } else {
        const nameValue = site.props.name!.children![1]!;
        edits.push(buildStringValueEdit(nameValue, target.name));
        records.push({ opId: rowKey, field: "name", oldValue: site.originalName, newValue: target.name });
      }
    }

    // title
    if (target.title !== null) {
      if (site.originalTitle !== null) {
        // Replace existing title.
        if (target.title !== site.originalTitle) {
          if (!isJsonSafeIdentifier(target.title)) {
            errors.push(`computed title '${target.title}' contains characters that would require escaping`);
          } else {
            const titleValue = site.props.title!.children![1]!;
            edits.push(buildStringValueEdit(titleValue, target.title));
            records.push({ opId: rowKey, field: "title", oldValue: site.originalTitle, newValue: target.title });
          }
        }
      } else {
        // Insert a new title property.
        if (!isJsonSafeIdentifier(target.title)) {
          errors.push(`computed title '${target.title}' contains characters that would require escaping`);
        } else {
          const insert = buildTitleInsertionEdit(source, site, target.title);
          if (!insert) {
            errors.push(
              `cannot insert title for OperationDefinition '${rowKey}' (no anchor property)`,
            );
          } else {
            edits.push(insert);
            records.push({ opId: rowKey, field: "title", oldValue: null, newValue: target.title });
          }
        }
      }
    }
  }

  // Type-op extension rewrites driven by id renames.
  if (idRenames.size > 0) {
    const exts = collectTypeOpExtensions(root);
    for (const e of exts) {
      const newId = idRenames.get(e.fragment);
      if (newId === undefined) continue;
      edits.push(buildStringValueEdit(e.valueNode, `#${newId}`));
      records.push({
        opId: newId,
        field: "valueCanonical",
        oldValue: `#${e.fragment}`,
        newValue: `#${newId}`,
      });
    }
  }

  // Detect any extension whose fragment doesn't resolve to any OpDef
  // id (after applying planned id changes). This is the "no dangling
  // refs" guarantee from the request. Only run this safety check when
  // at least one operation-side case was requested — when the caller
  // passes no operation-side cases (e.g. they're driving --operation-
  // canonical #ref alone, or only structure-side flags), planCaseChanges
  // is a no-op for this file and should not second-guess unrelated
  // ref state. (planRepair, when invoked, handles dangling refs on its
  // own terms.)
  const anyOpCase = idCase !== null || nameCase !== null || titleCase !== null;
  if (anyOpCase) {
    const finalIds = new Set<string>();
    for (const p of plans) {
      finalIds.add(p.target.id ?? p.site.originalId ?? "");
    }
    finalIds.delete("");
    const allExts = collectTypeOpExtensions(root);
    for (const e of allExts) {
      // Resolve old fragment through the rename map first.
      const resolved = idRenames.get(e.fragment) ?? e.fragment;
      if (!finalIds.has(resolved)) {
        errors.push(
          `type-operation valueCanonical '#${e.fragment}' does not resolve to any contained OperationDefinition.id`,
        );
      }
    }
  }

  return { edits, records, errors };
}
