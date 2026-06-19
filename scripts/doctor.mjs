import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const envPath = '.env.local'
const env = existsSync(envPath) ? readEnvFile(envPath) : new Map()
const supabaseCli = checkAnyCommand('supabase CLI', [
  ['supabase', ['--version']],
  ['npx.cmd', ['supabase', '--version']],
])
const checks = [
  checkCommand('node', ['--version']),
  checkCommand('npm.cmd', ['--version']),
  supabaseCli,
  { ...checkCommand('stripe', ['--version']), optional: true },
  checkEnv(env, 'VITE_SUPABASE_URL'),
  checkEnv(env, 'VITE_SUPABASE_ANON_KEY'),
  checkEnv(env, 'VITE_SUPABASE_FUNCTIONS_URL'),
  checkFile('supabase/config.toml'),
  checkFile('supabase/functions/ai/index.ts'),
  checkFile('supabase/functions/create-checkout-session/index.ts'),
  checkFile('supabase/functions/create-billing-portal/index.ts'),
  checkFile('supabase/functions/stripe-webhook/index.ts'),
  checkFile('supabase/migrations/20260618000100_profiles_usage.sql'),
  ...checkRemoteSecrets(supabaseCli.ok),
]

let failed = 0

for (const check of checks) {
  const marker = check.ok ? 'OK ' : check.optional ? 'WARN' : 'ERR'
  console.log(`${marker} ${check.label}${check.detail ? ` (${check.detail})` : ''}`)

  if (!check.ok && !check.optional) {
    failed += 1
  }
}

if (failed > 0) {
  console.log(`\n${failed} item(ns) precisam de configuracao antes do fluxo pago funcionar em producao.`)
  process.exitCode = 1
} else {
  console.log('\nTudo pronto para build local e deploy Supabase/Stripe.')
}

function readEnvFile(path) {
  const result = new Map()
  const content = readFileSync(path, 'utf8')

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)

    if (match) {
      result.set(match[1], match[2])
    }
  }

  return result
}

function checkEnv(envMap, name) {
  const value = envMap.get(name)

  return {
    label: `.env.local ${name}`,
    ok: typeof value === 'string' && value.trim().length > 0,
  }
}

function checkFile(path) {
  return {
    label: path,
    ok: existsSync(path),
  }
}

function checkCommand(command, args) {
  const commandLine = [command, ...args].join(' ')
  const result = spawnSync(commandLine, {
    encoding: 'utf8',
    shell: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/)[0]

  return {
    label: `${command} ${args.join(' ')}`,
    ok: result.status === 0,
    detail: result.status === 0 ? output : undefined,
  }
}

function checkAnyCommand(label, candidates) {
  const results = candidates.map(([command, args]) => checkCommand(command, args))
  const success = results.find((result) => result.ok)

  if (success) {
    return {
      label,
      ok: true,
      detail: success.detail,
    }
  }

  return {
    label,
    ok: false,
  }
}

function checkRemoteSecrets(canRunSupabase) {
  const required = [
    'GROQ_API_KEY',
    'OPENAI_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRO_PRICE_ID',
    'STRIPE_SUCCESS_URL',
    'STRIPE_CANCEL_URL',
    'STRIPE_PORTAL_RETURN_URL',
  ]

  if (!canRunSupabase) {
    return required.map((name) => ({
      label: `Supabase secret ${name}`,
      ok: false,
      detail: 'Supabase CLI indisponivel',
    }))
  }

  const result = spawnSync('npx.cmd supabase secrets list', {
    encoding: 'utf8',
    shell: true,
  })

  if (result.status !== 0) {
    return required.map((name) => ({
      label: `Supabase secret ${name}`,
      ok: false,
      detail: 'nao foi possivel listar secrets',
    }))
  }

  let names = new Set()

  try {
    const parsed = JSON.parse(result.stdout)
    names = new Set((parsed.secrets ?? []).map((secret) => secret.name))
  } catch {
    return required.map((name) => ({
      label: `Supabase secret ${name}`,
      ok: false,
      detail: 'saida inesperada de secrets list',
    }))
  }

  return required.map((name) => ({
    label: `Supabase secret ${name}`,
    ok: names.has(name),
  }))
}
