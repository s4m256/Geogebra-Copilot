# GeoGebra Copilot

Natural-language geometry compiled from typed semantic objects into deterministic GeoGebra commands.

[Compiler](src/geometryCompiler.ts) · [Extended implementation and tests](https://github.com/s4m256/Geogebra-Copilot/tree/test) · [Branch review plan](docs/CANONICAL_BRANCH_PLAN.md)

```mermaid
flowchart LR
    A[Natural language] --> B[AI-generated semantic JSON]
    B --> C[Strict Zod schema validation]
    C --> D[Deterministic compiler]
    D --> E[GeoGebra]
```

![Compiler-generated triangle with altitude foot D and orthocenter H](docs/compiler-proof.jpg)

*Fixed semantic input executed in the actual GeoGebra applet; no AI request. [Input, emitted commands and reproduction](docs/CONSTRUCTION.md).*

## Why

An altitude, orthocenter or reflection has meaning beyond command syntax. The model returns typed construction objects; TypeScript code owns the command strings. This architecture is already present on `main`, although the previous README incorrectly described raw command generation.

## Technical highlights

- [Strict Zod schemas](src/ai.ts) check supported object shapes before compilation. An invalid response gets one repair request with validation feedback.
- The [compiler](src/geometryCompiler.ts) expands objects into ordered GeoGebra commands and reuses auxiliary lines and altitude constructions.
- The model prompt asks for semantic JSON; [the bridge](src/geogebra.ts) manages execution in the embedded applet.
- Supported objects on `main` include points, triangles/quadrilaterals, segments, lines, midpoints, altitude feet, orthocenters, diameter-defined circles, intersections and reflections.

## Concrete output

With points `A` and `B` already defined:

```json
{ "type": "midpoint", "name": "M", "of": ["A", "B"] }
```

compiles to `M = Midpoint(A, B)`. An orthocenter is compiled as the intersection of constructed altitude lines rather than delegated to the model as raw command syntax.

## Extended validation on `test`

The [semantic library](https://github.com/s4m256/Geogebra-Copilot/blob/test/src/semanticConstruction.ts) adds duplicate-name and dependency checks, and additional constructions such as circumcenters, incenters, parallel lines and angle bisectors:

```mermaid
flowchart LR
    A[Typed geometry objects] --> B[Schema and dependency validation]
    B --> C[Deterministic compiler]
    C --> D[GeoGebra commands]
```

**Integration boundary:** this stronger library is tested, but `test`'s Supabase runtime uses a separate parser/compiler in `supabase/functions/_shared/copilot.ts`. That parser checks the response envelope rather than calling the strict library. Do not infer that the complete validation chain currently guards live backend requests. See the [review plan](docs/CANONICAL_BRANCH_PLAN.md).

## Verification

For this default branch:

```bash
npm ci
npm run build
npm run lint
```

For the extended library:

```bash
git clone --branch test https://github.com/s4m256/Geogebra-Copilot.git geogebra-semantic
cd geogebra-semantic
npm ci
npm run verify
```

The `test` branch passed **9 tests, TypeScript/Vite build and ESLint** on 2026-09-19. Tests exercise schema/reference rejection, compiler output and command normalization. They are not live-provider or geometric-correctness guarantees.

## Preview and development

The [hosted preview](https://geogebra-copilot.vercel.app) loads the canvas, but submitting a request returned a missing `VITE_GROQ_API_KEY` error during the audit. It is not currently presented as a working AI demo. The previous no-key fenced-command instructions did not work in this check.

Run `npm run dev` locally. `main` uses `VITE_GROQ_API_KEY` in browser code: Vite client variables are exposed, so do not publish a private provider key in a frontend bundle. The `test` branch moves provider calls behind Supabase; see its [backend setup](https://github.com/s4m256/Geogebra-Copilot/blob/test/supabase/README.md).

## Limits

The compiler is not a theorem prover. Schema checks do not establish nondegeneracy or mathematical correctness. Authentication, plan routing and billing on `test` require separate end-to-end verification.
