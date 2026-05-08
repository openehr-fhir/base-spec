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
- `lower-kebab` — `lower-kebab-case` (aliases: `lower-hyphen`, `lower-dash`)
- `Title-Kebab` — `Title-Kebab-Case` (aliases: `Title-Hyphen`, `Title-Dash`)
- `Pascal-Kebab` — `Pascal-Kebab-Case` (aliases: `Pascal-Hyphen`, `Pascal-Dash`)
- `Upper-Kebab` — `UPPER-KEBAB-CASE` (aliases: `Upper-Hyphen`, `Upper-Dash`)
- `lowerCamel` — `lowerCamelCase` (alias: `camel`)
- `UpperPascal` — `UpperPascalCase` (alias: `Pascal`)

Property-specific case allowlists:

- `--operation-id`, `--structure-id`: `lower_snake`, `lower-kebab`.
- `--operation-name`, `--operation-title`, `--structure-name`,
  `--structure-title`: any of the seven cases above.
- `--structure-canonical`: any of the seven cases above (operates on
  the **final** segment of each canonical URL).

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
    --operation-name UpperPascal \
    --operation-title UpperPascal \
    --update

# Re-case the StructureDefinition top-level fields.
bun tools/changeTypeFunctionCasing.ts \
    --structure-id Upper-Kebab \
    --structure-name UpperPascal \
    --structure-title UpperPascal \
    --update

# Re-case every SD canonical-URL final segment plus all in-package
# cross-references (code/profile/targetProfile/valueCanonical/valueUrl).
bun tools/changeTypeFunctionCasing.ts --structure-canonical Upper-Kebab --update

# Combined matrix: operation-side + structure-side + SD-canonical in one pass.
bun tools/changeTypeFunctionCasing.ts \
    --operation-id lower_snake \
    --operation-canonical '#ref' \
    --structure-id Upper-Kebab \
    --structure-canonical Upper-Kebab \
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

## Tests

```sh
cd tools
bun test
```
