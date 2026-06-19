$ErrorActionPreference = "Stop"

if (Get-Command supabase -ErrorAction SilentlyContinue) {
  $supabase = "supabase"
} elseif (Get-Command npx.cmd -ErrorAction SilentlyContinue) {
  $supabase = "npx.cmd supabase"
} else {
  throw "Supabase CLI nao encontrado. Instale no projeto com npm.cmd install -D supabase."
}

Invoke-Expression "$supabase db push"
Invoke-Expression "$supabase functions deploy ai"
Invoke-Expression "$supabase functions deploy create-checkout-session"
Invoke-Expression "$supabase functions deploy create-billing-portal"
Invoke-Expression "$supabase functions deploy stripe-webhook --no-verify-jwt"

Write-Host "Deploy Supabase concluido. Configure o webhook no Stripe apontando para /functions/v1/stripe-webhook."
