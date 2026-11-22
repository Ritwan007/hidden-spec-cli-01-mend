# mend

One patch tool for every AI edit format. `mend` reads a patch in one of four
formats — unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits — finds each
edit's old lines at the first of three matching tiers (exact, trailing
whitespace, indentation), and writes every change or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file; absent or `-` reads the patch from stdin.
`--format` is `unified`, `search-replace`, `v4a`, `json`, or `auto` (the
default, which detects the format). `--check` prints what would change
without writing anything. `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`/`D`/`M`, or `R <old> -> <new>`
for a move) and `ok: <n> files`. Exit 1 lists each failed edit and
`failed: <k> of <n> edits`; nothing is written. Exit 2 reports a usage,
missing-patch, undetected-format, or parse error on one line.

## Layout

- `main.ts` — the whole tool (Node 22, standard library only)
- `runner.ts` — the trial harness (unchanged from the kit)
- `check.ts` — runs `main.ts` over the practice set
- `SPEC.md` — the full contract this implements
