# Semantic branch promotion plan

Baseline: `test` at `2df8dbc` is 27 commits ahead of `main`, with no unique commits on `main` at audit time. `main` already has semantic JSON, strict Zod object schemas and a deterministic compiler. The old README was inaccurate.

`docs/semantic-architecture` is a review branch based on the tested `test` implementation. It adds documentation without rewriting history or replacing working code.

## Release blocker found in source

The extended strict parser/dependency validator in `src/semanticConstruction.ts` and compiler in `src/geometryCompiler.ts` are covered by nine tests. The live frontend instead calls the Supabase function, whose `_shared/copilot.ts` contains a separate parser/compiler. `parseModelContent` checks JSON/envelope shape and casts its contents; it does not call the strict validator. Passing library tests therefore does not verify the backend validation boundary.

## Safe sequence

1. Review the 27 commits against `main`, including auth, billing, deployment and geometry changes. Do not promote solely because this branch is newer.
2. In a bounded follow-up, share the tested schema/compiler with the backend or apply equivalent validation there. Add request-boundary regressions for duplicate names, missing references, unsupported types and correct command output.
3. Run `npm ci` and `npm run verify`; the audit baseline passed 9 tests, build and lint.
4. Configure a preview with server-side provider secrets. Exercise sign-in, a triangle with altitude/orthocenter, an invalid construction, reset and a second construction.
5. Apply `RELEASE_CHECKLIST.md` to the chosen backend scope. Auth/Stripe readiness is not established by compiler tests.
6. Merge normally after review, preserving history; verify the deployed revision and repeat the construction test. Then update the README branch note and label the live demo functional.

The hosted preview currently returns a missing provider-key message. Neither production credentials nor billing configuration was changed during this audit.
