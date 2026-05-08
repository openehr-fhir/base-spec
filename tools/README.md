# tools/

Repo automation scripts for the openEHR base IG. Currently:

- `changeTypeFunctionCasing.ts` — bulk-rename casing in
  `input/resources/*.json`. Re-cases the contained
  `OperationDefinition` resources (`id`/`name`/`title` and matching
  `type-operation` `valueCanonical` fragment refs), the parent
  `StructureDefinition`'s top-level `id`/`name`/`title` fields, and
  the SD canonical-URL trio (`url` / `type` / `baseDefinition`) plus
  every cross-file reference at `code`, `profile`, `targetProfile`,
  `valueCanonical`, and `valueUrl`.

## Install

[Bun](https://bun.sh) is required (≥ 1.2). One-time, from the repo root:

```sh
cd tools
bun install
```

`tools/node_modules/` and `tools/bun.lock`/`tools/bun.lockb` are
gitignored. Reproducibility relies on the SemVer ranges in
`tools/package.json`.

## `changeTypeFunctionCasing.ts`

Walks every `*.json` directly under `input/resources/` (resolved
relative to the current working directory; the maintainer is expected
to run from the repo root) and re-cases the requested set of identifier
and URL fields.

Edits are **byte-precise**: the script only modifies the bytes inside
the affected string literals (or, for an inserted `title`, mirrors the
EOL/indent style of a sibling property). Whitespace, key order, EOL
style (CRLF or LF), and the trailing EOF byte are all preserved.

The script is **preview-by-default**: without `--update`, it prints the
report and writes nothing. Pass `--update` to apply.

### Flags

The flag surface is a 2×4 matrix: rows are which resource is being
re-cased (operation = contained `OperationDefinition`, structure =
parent `StructureDefinition`); columns are which property:

| Property        | OperationDefinition (contained)              | StructureDefinition (parent)  |
|-----------------|----------------------------------------------|-------------------------------|
| `id`            | `--operation-id <case>` (alias `--op-id`)    | `--structure-id <case>` (alias `--sd-id`) |
| `name`          | `--operation-name <case>` (alias `--op-name`)| `--structure-name <case>` (alias `--sd-name`) |
| `title`         | `--operation-title <case>` (alias `--op-title`) | `--structure-title <case>` (alias `--sd-title`) |
| canonical / ref | `--operation-canonical <mode>` (alias `--op-canonical`) | `--structure-canonical <case>` (alias `--sd-canonical`) |

Other flags:

| Flag | Behavior |
|------|----------|
| `--update` | Apply edits. Without `--update`, the report is printed and nothing is written. |
| `--help`   | Print usage. |

`<case>` is one of:

- `lower_snake` — `lower_snake_case`
- `lower-kebab` — `lower-kebab-case`
- `Title_Snake` — `Title_Snake_Case`
- `Title-Kebab` — `Title-Kebab-Case`
- `UPPER_SNAKE` — `UPPER_SNAKE_CASE`
- `UPPER-KEBAB` — `UPPER-KEBAB-CASE`
- `camel` — `lowerCamelCase`
- `Pascal` — `UpperPascalCase`

Input is case-insensitive; `-` and `_` are interchangeable separators
(e.g. `LOWER-KEBAB`, `lower_kebab`, and `Lower-Kebab` all resolve to
canonical `lower-kebab`). Single-token `pascal` resolves to `camel`
and single-token `CAMEL` resolves to `Pascal` (the canonical chosen
follows the first character of the input); `pascal` as a family
keyword in two-token forms (e.g. `pascal-kebab`, `PASCAL_SNAKE`) is
a synonym for `title`.

Every case-taking matrix flag accepts the same 8-name allowlist.

`--operation-canonical <mode>` is the ref-sync switch (analogous to
the old `--repair`). `<mode>` is one of:

- `none` (alias `na`) — do nothing.
- `ref` (alias `#`, `#ref`) — rewrite every `type-operation`
  `valueCanonical` `#ref` fragment to match the *current*
  `OperationDefinition.id` it refers to (matched by token equality).

#### Flag-combination rules

- **At least one** matrix flag is required (otherwise there is nothing
  to do, exit code `2`).
- Long and short alias forms of the same flag are mutually exclusive
  (e.g. `--operation-id lower_snake --op-id lower-kebab` exits `2`).
- Combining `--operation-canonical ref` with `--operation-id <case>`
  is allowed but redundant: the id rename already syncs every `#ref`,
  so the canonical-sync planner is skipped.
- If `--operation-id` or `--structure-id` is given a case whose
  canonical name contains `_` (i.e. `lower_snake`, `Title_Snake`,
  `UPPER_SNAKE`), a one-line stderr warning is printed once per flag
  (the FHIR `id` regex forbids `_`). The exit code is unaffected.

Any violation exits with code `2` and a single stderr line.

> **Shell tip:** `--operation-canonical #ref` includes a `#`, which
> POSIX shells (bash, zsh, …) treat as a comment. Quote it:
> `--operation-canonical '#ref'`. PowerShell does not need quoting.

### Example invocations

```sh
# Preview-by-default. Print the changes; write nothing.
bun tools/changeTypeFunctionCasing.ts --operation-id lower_snake

# Apply the same change.
bun tools/changeTypeFunctionCasing.ts --operation-id lower_snake --update

# Sync #refs to current OperationDefinition.id values, no case changes.
bun tools/changeTypeFunctionCasing.ts --operation-canonical '#ref' --update

# FHIR-flavored: kebab id, Pascal name+title, refs follow the new id.
bun tools/changeTypeFunctionCasing.ts \
    --operation-id lower-kebab \
    --operation-name Pascal \
    --operation-title Pascal \
    --update

# Re-case the StructureDefinition top-level fields.
bun tools/changeTypeFunctionCasing.ts \
    --structure-id UPPER-KEBAB \
    --structure-name Pascal \
    --structure-title Pascal \
    --update

# Re-case operation-side fields to Title-Kebab.
bun tools/changeTypeFunctionCasing.ts \
    --operation-id lower-kebab \
    --operation-name Title-Kebab \
    --operation-title Title-Kebab \
    --update

# Re-case every SD canonical-URL final segment plus all in-package
# cross-references (code/profile/targetProfile/valueCanonical/valueUrl).
bun tools/changeTypeFunctionCasing.ts --structure-canonical UPPER-KEBAB --update

# Combined matrix: operation-side + structure-side + SD-canonical in one pass.
bun tools/changeTypeFunctionCasing.ts \
    --operation-id lower_snake \
    --operation-canonical '#ref' \
    --structure-id UPPER-KEBAB \
    --structure-canonical UPPER-KEBAB \
    --update
```

### Report format

```
=== <relative-file-path> ===
  <id>.<field>: "<old>" -> "<new>"
  <id>.<field>: <inserted> "<new>"
  ...

<N> change(s) across <M> file(s).
```

`<id>` is the SD `id` for SD-rooted records (top-level fields and
canonical-URL changes), or the contained OpDef `id` for OpDef records.
For SD-canonical cross-ref records, the leading `differential.` or
`snapshot.` segment is dropped from the rendered field path (e.g.
`ACTIVITY.element[3].type[0].code` rather than
`ACTIVITY.differential.element[3].type[0].code`).

Files with zero changes are omitted from the per-file blocks but
counted in the summary. `<M>` counts files with at least one change.
The `<inserted>` marker replaces `"<old>" ->` when a new property was
created (e.g. a missing `title`).

The same format is emitted for both preview and `--update` runs.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success — any number of changes (including zero). |
| `1` | One or more files reported errors (malformed JSON, duplicate ids, dangling/ambiguous `#ref`, divergent SD `url` vs `type`, trailing-byte preservation failure). |
| `2` | Argv/usage error, or no matrix flag specified. |

## Out of scope (v1)

- Positional file or glob arguments.
- Wiring the script into the IG publish/build pipeline.
- Renaming files on disk to follow id casing changes.
- Re-casing `OperationDefinition.code` or
  `OperationDefinition.parameter[*].name`.
- `--structure-canonical`: rewriting URLs that match a discovered
  canonical only by version-prefix (e.g. `.../FOO|1.2.0`). Versioned
  references are skipped.
- Per-token rendering overrides. `format(tokens, case)` always
  normalizes per-token (lowercases the token then applies the case
  shape); all-caps input tokens such as `EHR` are not preserved
  (e.g. `format(["DV","EHR","URI"], "Pascal") === "DvEhrUri"`, not
  `"DVEHRURI"`). No DSL is exposed for forcing per-token casing.

## Tests

```sh
cd tools
bun test
```
