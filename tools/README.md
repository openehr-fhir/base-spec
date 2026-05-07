# tools/

Repo automation scripts for the openEHR base IG. Currently:

- `changeTypeFunctionCasing.ts` — bulk-toggle the casing of openEHR
  type-function `OperationDefinition` resources contained inside
  `input/resources/*.json`, and keep the matching root
  `type-operation` `valueCanonical` fragment refs in sync.

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
to run from the repo root) and re-cases the contained
`OperationDefinition.id`/`name`/`title` fields and the parent
resource's root `extension[]` `type-operation` `valueCanonical`
fragment refs.

Edits are **byte-precise**: the script only modifies the bytes inside
the affected string literals (or, for an inserted `title`, mirrors the
EOL/indent style of a sibling property). Whitespace, key order, EOL
style (CRLF or LF), and the trailing EOF byte are all preserved.

### Flags

| Flag | Behavior |
|------|----------|
| `--all-snake` | Set `id`, `name`, `title` to `lower_snake_case`; rewrite all matching `#refs` to `#lower_snake`. |
| `--all-fhir`  | Set `id` to `lower-kebab-case`; set `name` and `title` to `UpperPascalCase`; rewrite matching `#refs` to `#lower-kebab`. |
| `--id-case <case>` | Set `id` to one of `lower_snake`, `lower-kebab` (aliases: `lower-hyphen`, `lower-dash`). Matching `#refs` follow the renamed `id`. |
| `--name-case <case>` | Set `name` to one of `lower_snake`, `lower-kebab`, `Upper-Kebab`, `lowerCamel`, `UpperPascal` (aliases: `lower-hyphen`, `lower-dash`, `Upper-Hyphen`, `Upper-Dash`, `camel`, `Pascal`). |
| `--title-case <case>` | Same value set as `--name-case`, applied to `title`. If `title` is absent, a new property is inserted (value derived from `code` → `id` → `name`, formatted in the requested case). |
| `--repair` | Do not change any casing. Walk every `type-operation` `#ref` and rewrite it to match the *current* `OperationDefinition.id` it refers to (matched by token equality). Mutually exclusive with every other case-specifying flag. |
| `--dry-run` | Print the change report only; write nothing. Combinable with any of the above. |
| `--help` | Print usage. |

#### Flag-combination rules

- `--all-snake` and `--all-fhir` are mutually exclusive.
- `--all-snake`/`--all-fhir` may **not** be combined with any of
  `--id-case`, `--name-case`, `--title-case`.
- `--repair` may **not** be combined with any case-specifying flag.
- At least one of `--all-snake`, `--all-fhir`, `--id-case`,
  `--name-case`, `--title-case`, or `--repair` is required.

Any violation exits with code `2` and a single stderr line.

### Example invocations

```sh
# Make everything lower_snake_case (id, name, title, and #refs):
bun tools/changeTypeFunctionCasing.ts --all-snake

# FHIR-flavored: kebab id, Pascal name+title, kebab #refs:
bun tools/changeTypeFunctionCasing.ts --all-fhir

# Mix-and-match:
bun tools/changeTypeFunctionCasing.ts \
    --id-case lower-kebab --name-case UpperPascal --title-case lower_snake

# Repair mode: leave casing alone, just sync #refs to the current id:
bun tools/changeTypeFunctionCasing.ts --repair

# Preview only — print the changes that would be made, write nothing:
bun tools/changeTypeFunctionCasing.ts --all-snake --dry-run
```

### Recommended workflow when the spec is currently inconsistent

If the existing `#refs` and `OperationDefinition.id` values are out of
sync (e.g. snake `#refs` pointing at kebab ids), case-changing modes
that don't rename the ids will fail with `does not resolve to any
contained OperationDefinition.id` errors. Run `--repair` first to
align the refs, then run the case-changing flag of your choice:

```sh
bun tools/changeTypeFunctionCasing.ts --repair
bun tools/changeTypeFunctionCasing.ts --all-fhir
```

### Report format

```
=== <relative-file-path> ===
  <op-id>.<field>: "<old>" -> "<new>"
  <op-id>.<field>: <inserted> "<new>"
  ...

<N> change(s) across <M> file(s).
```

Files with zero changes are omitted from the per-file blocks but
counted in the summary. `<M>` counts files with at least one change.
The `<inserted>` marker replaces `"<old>" ->` when a new property was
created (e.g. a missing `title`).

The same format is emitted for both `--dry-run` and write-mode runs.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success — any number of changes (including zero). |
| `1` | One or more files reported errors (malformed JSON, duplicate ids, dangling/ambiguous `#ref`, trailing-byte preservation failure). |
| `2` | Argv/usage error, or no case-specifying flag and no `--repair`. |

## Out of scope (v1)

- Scanning for `type-operation` extensions in non-root locations
  (`differential.element[*].extension[]`,
  `snapshot.element[*].extension[]`, `parameter[*].extension[]`).
- Rewriting `OperationDefinition.code` or
  `OperationDefinition.parameter[*].name`.
- Cross-file `valueCanonical` references (absolute URLs pointing at
  other files — these are skipped silently).
- Positional file or glob arguments.
- Wiring the script into the IG publish/build pipeline.

## Tests

```sh
cd tools
bun test
```
