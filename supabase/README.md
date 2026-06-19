# Supabase Backend

This folder contains the first backend boundary for hiding AI provider keys from the browser.

## Secrets

Set these in Supabase before deploying functions:

```bash
supabase secrets set GROQ_API_KEY=...
supabase secrets set OPENAI_API_KEY=...
supabase secrets set STRIPE_SECRET_KEY=...
supabase secrets set STRIPE_WEBHOOK_SECRET=...
supabase secrets set STRIPE_PRO_PRICE_ID=...
supabase secrets set STRIPE_SUCCESS_URL=https://your-app/success
supabase secrets set STRIPE_CANCEL_URL=https://your-app/cancel
supabase secrets set STRIPE_PORTAL_RETURN_URL=https://your-app/account
```

`STRIPE_SUCCESS_URL` and `STRIPE_CANCEL_URL` can point to the app root. The checkout function adds `checkout=success` or `checkout=cancel` before sending the user back.

Optional usage limit:

```bash
supabase secrets set FREE_DAILY_LIMIT=50
```

Optional model overrides:

```bash
supabase secrets set GROQ_MODEL=llama-3.3-70b-versatile
supabase secrets set OPENAI_MODEL=gpt-4.1
```

## Functions

- `ai`: single Copilot endpoint. It reads the authenticated user, checks `profiles.plan`/`profiles.is_pro`, applies free usage limits, then routes `free` users to Groq and `pro` users to OpenAI. Request body accepts `mode: "draw" | "solve"`; `solve` is Pro-only and may return explanation without construction commands.
- `create-checkout-session`: creates a Stripe subscription checkout for the authenticated user.
- `create-billing-portal`: opens Stripe's billing portal for pro users with a stored Stripe customer.
- `stripe-webhook`: updates `profiles.plan`, `profiles.is_pro`, and Stripe subscription fields from subscription status using `metadata.supabase_user_id`.

The browser never receives provider keys. Apply the migrations in `supabase/migrations` before relying on plan routing or usage records.

## Frontend Env

The app needs these public values to enable login and checkout:

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_public_anon_key
VITE_SUPABASE_FUNCTIONS_URL=https://your-project.supabase.co/functions/v1
```

## Deploy Checklist

From the repository root on Windows, after the Supabase CLI is installed and linked:

```powershell
.\scripts\deploy-supabase.ps1
```

Equivalent manual commands:

```bash
supabase link --project-ref your-project-ref
supabase db push
supabase functions deploy ai
supabase functions deploy create-checkout-session
supabase functions deploy create-billing-portal
supabase functions deploy stripe-webhook --no-verify-jwt
```

In Stripe, create a webhook endpoint pointing to:

```text
https://your-project.supabase.co/functions/v1/stripe-webhook
```

Subscribe it at minimum to:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```
