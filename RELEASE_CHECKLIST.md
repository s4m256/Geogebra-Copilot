# Release Checklist

Use this before shipping a Vercel/Supabase/Stripe release.

## Local

```powershell
$env:PATH += ";C:\Users\alunomedioald\Downloads\node-v24.15.0-win-x64\node-v24.15.0-win-x64"
npm.cmd run verify
npm.cmd run doctor
```

`verify` runs tests, production build, and lint.

## Vercel

Set only public frontend variables:

```text
VITE_SUPABASE_URL=https://ktyrpsnyiluiucxbpkur.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_NVvc-zyqL8vQmHUJjmLPow_lr7Q30E3
VITE_SUPABASE_FUNCTIONS_URL=https://ktyrpsnyiluiucxbpkur.supabase.co/functions/v1
VITE_GEOGEBRA_DEPLOY_URL=https://www.geogebra.org/apps/deployggb.js
```

Do not put provider or Stripe secrets in Vercel.

## Supabase

Deploy functions after backend changes:

```powershell
.\scripts\deploy-supabase.ps1
```

Required secrets:

```text
GROQ_API_KEY
OPENAI_API_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRO_PRICE_ID
STRIPE_SUCCESS_URL
STRIPE_CANCEL_URL
STRIPE_PORTAL_RETURN_URL
```

## Stripe

Create a webhook endpoint:

```text
https://ktyrpsnyiluiucxbpkur.supabase.co/functions/v1/stripe-webhook
```

Subscribe to:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

Copy the signing secret and set it:

```powershell
npx.cmd supabase secrets set STRIPE_WEBHOOK_SECRET="whsec_..."
```

Run `npm.cmd run doctor` again. The paid flow is production-ready only when `doctor` reports no required errors.
