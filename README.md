# GeoGebra Copilot

GeoGebra Copilot turns natural-language geometry requests into validated semantic geometry JSON, compiles that JSON into GeoGebra commands, and executes the commands in an embedded GeoGebra workspace.

## Run

On this Windows setup, first expose the portable Node install:

```powershell
$env:PATH += ";C:\Users\alunomedioald\Downloads\node-v24.15.0-win-x64\node-v24.15.0-win-x64"
```

Then run commands with `npm.cmd`:

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run build
npm.cmd run lint
npm.cmd run test
npm.cmd run verify
npm.cmd run doctor
```

## AI Configuration

Create `.env.local` with the public Supabase values used by the browser:

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_public_anon_key
VITE_SUPABASE_FUNCTIONS_URL=https://your-project.supabase.co/functions/v1
```

Backend secrets live in Supabase, not in the frontend:

```bash
supabase secrets set GROQ_API_KEY=...
supabase secrets set OPENAI_API_KEY=...
supabase secrets set STRIPE_SECRET_KEY=...
supabase secrets set STRIPE_WEBHOOK_SECRET=...
supabase secrets set STRIPE_PRO_PRICE_ID=...
supabase secrets set STRIPE_SUCCESS_URL=http://localhost:5173
supabase secrets set STRIPE_CANCEL_URL=http://localhost:5173
supabase secrets set STRIPE_PORTAL_RETURN_URL=http://localhost:5173
```

The checkout function appends `?checkout=success` or `?checkout=cancel` to the success and cancel URLs, so these secrets can be the base app URL.

## Plans

- Free users use Draw mode backed by the lower-cost model.
- Pro users can use Draw or Solve mode. Solve mode is backed by the stronger model and can return a text explanation with an optional construction.
- The UI should stay focused: one prompt box, one GeoGebra workspace, and a clean chat history.
- In production backend mode, users sign in with an email magic link before using Copilot. Free users see `Assinar Pro`, which opens Stripe Checkout.

## Architecture

```text
Natural language
  -> AI provider or Supabase Edge Function
  -> semantic JSON
  -> schema and dependency validation
  -> deterministic geometry compiler
  -> GeoGebra bridge
  -> GeoGebra API
```

React owns UI and state. GeoGebra owns the construction canvas. The bridge in `src/geogebra.ts` is the only module that talks directly to the applet API.

The model must never return raw GeoGebra commands. It returns supported semantic objects such as `point`, `polygon`, `altitudeFoot`, `orthocenter`, `parallelLine`, `perpendicularBisector`, `circumcenter`, and `incenter`; the compiler owns the actual command strings.

## Backend Roadmap

The current Supabase function is the provider boundary:

- `supabase/functions/ai`: single AI endpoint. It reads the authenticated user's `profiles.plan`/`profiles.is_pro` state and routes free users to Groq and pro users to OpenAI.
- `mode: "draw" | "solve"` is sent in the request body. `solve` returns an explanation and optional commands, and is limited to Pro users.
- `supabase/functions/create-checkout-session`: creates a Stripe Checkout subscription session for the authenticated user.
- `supabase/functions/create-billing-portal`: lets pro users manage or cancel billing in Stripe.
- `supabase/functions/stripe-webhook`: updates the stored user plan from Stripe subscription events.

The browser never receives provider keys. Supabase Auth, the `profiles` table (`plan`, `is_pro`, Stripe customer/subscription fields), usage events, and signed Stripe webhook data are the backend source of truth for plan routing.

Run `npm.cmd run doctor` before testing the paid flow. It reports missing local env vars and CLIs without printing secret values.

Use [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) before shipping a Vercel/Supabase/Stripe release.
