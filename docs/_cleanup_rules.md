# Comment & documentation rules

Derived from [`_cleanup_audit.md`](_cleanup_audit.md). These are the rules the
cleanup pass applies, and the standard for new comments afterwards.

The audit's headline matters for how aggressive these rules are: this codebase's
comments are mostly *good* — they carry invariants and rejected alternatives that
can't be recovered from the code. So the default is **prune and correct, not
delete**. A long comment that earns its length keeps it.

## 1. Keep the why, drop the what

Delete a comment that restates what the next line does. Keep one that explains
why the code is that way, what breaks otherwise, or what was tried and rejected.

```rust
// ✗ Creates the parent dir, then writes the file.
// ✓ Writers own dir creation, so a read of a not-yet-existing dir fails
//   harmlessly as "nothing cached".
```

A comment that names a *consequence* ("without this, X breaks") is a why. A
comment that names a *mechanism already visible in the code* is a what.

## 2. Public API: a concise contract. Internal: usually nothing

- **Exported / `pub`**: one or two sentences — what it returns, and any
  non-obvious precondition, side effect or failure mode. State the contract, not
  the implementation.
- **Internal helpers**: no comment by default. Comment only when the function is
  subtle (a non-obvious algorithm, a deliberate ordering, a guard against a
  specific bug).
- Never restate the signature in prose. `fn slim_airports(raw, precision)` does
  not need "takes a raw response and a precision".

## 3. One owner per fact

A fact lives in exactly one place. Everywhere else refers to it.

- Same file, same language → delete the copy, keep the better-placed one.
  Prefer the definition site over the call site.
- Cross-language (Rust ↔ TS ↔ YAML) → duplication is unavoidable; keep it, but
  each copy must point at the owner (`// must match SCHEDULE_ROOT in
  src/core/schedule.ts`). `schedule-test.ts` machine-checks five such copies —
  that pattern is the standard, not the exception.

## 4. No change-history in comments

Git holds the history. Delete:

- "Replaces the old X", "no longer uses Y", "used to be Z", "previously W".
- Comparisons whose only baseline is a pre-refactor state ("instead of the old
  roads-only reimplementation").
- Anything documenting a mechanism that no longer exists.

**Exception:** a historical fact that changes what a reader must *do* stays —
rewritten as a present-tense rule. `OSM_SCHEMA_VERSION`'s note that version 5
covers two payload changes is a live trap for the next person bumping it, so it
stays; the story of how it got that way goes.

## 5. No meta-narrative

The comment describes the code, not the work that produced it. Delete:

- "out of scope here", "pre-existing", "TODO(later)" without an issue link.
- "until this check existed…", "this stayed wrong for two releases".
- Apologetic or self-congratulatory framing.

A known gap is stated as a fact about current behaviour: *"this path doesn't
persist the change"* — not *"doesn't persist; pre-existing, out of scope"*.

## 6. Correct or delete a conflicting comment — never leave both

Where a comment disagrees with the implementation, the implementation wins.
Rewrite the comment to match. If the correct content isn't determinable from the
code, the comment goes to `_cleanup_questions.md` and is left untouched.

Cross-references must resolve: every `path/to/file.ts` and `module::function`
named in a comment gets checked against the tree.

## 7. Placement

- A comment sits **immediately above** what it describes, no blank line between.
  A comment separated from its subject by a blank line reads as documenting the
  wrong thing (this is a real defect in two files).
- Module/file headers go **above the imports**, so the file opens with what it is.
- Rust module docs use `//!`. Item docs use `///`. Non-doc asides use `//`.
- TS/TSX: exported items use `/** */`; inline asides use `//`.

## 8. Formatting conventions

- Issue references: `(issue #11)` on first mention in a file, bare `#11` after.
- Wrap at ~88 columns to match the surrounding code.
- The existing typographic style (`—`, `•`, `⇒`, `─────` section banners) is
  house style and is preserved. Not extended to files that don't already use it.
- Section banners are for files over ~400 lines with distinct phases
  (`pipeline.rs`, `render.ts`). Not for short modules.

## 9. Docs (`.md`)

- A doc that describes a superseded mechanism as current gets corrected, and
  points at the doc that owns the current one.
- Status tables ("✅ implemented") are dated or removed — an undated status claim
  rots silently.
- Every file path and symbol name in a doc must resolve.
- Contributor-facing setup commands must match what CI actually runs.

## 10. What this pass will not do

- No logic changes. Comments, doc comments and `.md` files only.
- No renaming, no reformatting of code, no import reordering.
- No touching `src/components/ui/*` (vendored shadcn), `CHANGELOG.md`
  (generated), `CLAUDE.md` (user-owned), or `src/i18n/*.json` (data).
- No deleting a comment whose correctness can't be established by reading the
  implementation — those go to `_cleanup_questions.md`.
- No log/error message edits (those are user-visible strings, not comments).
