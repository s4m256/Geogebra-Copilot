# GeoGebra Copilot

GeoGebra Copilot is a browser-only React app that turns natural-language geometry requests into GeoGebra commands.

## Run

Create a `.env.local` file when LLM generation is needed:

```text
VITE_GROQ_API_KEY=your_groq_key
```

Then run:

```bash
npm install
npm run dev
```

You can also paste a fenced GeoGebra block into the prompt box and execute it without a Groq key:

````text
```geogebra
A = (0, 0)
B = (4, 0)
s1 = Segment(A, B)
```
````

## Architecture

```text
Natural language
  -> Groq LLM
  -> fenced GeoGebra commands
  -> parser
  -> GeoGebra bridge
  -> GeoGebra API
```

React owns UI and state. GeoGebra owns the construction canvas. The bridge in `src/geogebra.ts` is the only module that talks directly to the applet API.
