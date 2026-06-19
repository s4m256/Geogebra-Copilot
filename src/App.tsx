import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent } from 'react'
import { requestConstruction, type ConstructionResponse, type CopilotMode } from './ai'
import {
  clearGeoGebraConstruction,
  createGeoGebraApplet,
  executeGeoGebraCommands,
  type CommandExecutionResult,
  type GeoGebraApi,
} from './geogebra'
import { normalizeGeoGebraBlock, type NormalizeResult } from './lib/ggbCommandNormalizer'
import {
  clearStoredSession,
  createBillingPortalSession,
  createCheckoutSession,
  fetchPlan,
  isBackendAiConfigured,
  isCheckoutConfigured,
  isSupabaseConfigured,
  readSessionFromUrl,
  readStoredSession,
  requestMagicLink,
  refreshSession,
  signOut,
  type AuthSession,
  type Plan,
} from './supabaseRest'
import './App.css'

type Message = {
  id: string
  from: 'user' | 'copilot'
  text: string
}

const EXAMPLE_PROMPTS: Record<CopilotMode, string[]> = {
  draw: [
    'Desenhe um triangulo ABC e marque o ortocentro.',
    'Crie um circulo com diametro AB.',
    'Desenhe a mediatriz de AB e uma reta paralela a BC passando por A.',
  ],
  solve: [
    'Resolva: em um triangulo ABC, mostre por que as alturas se encontram no ortocentro.',
    'Explique como construir o circuncentro de um triangulo e por que ele funciona.',
    'Resolva um problema com bissetriz interna e incentro, gerando a construcao se ajudar.',
  ],
}

function App() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [statusText, setStatusText] = useState('Carregando GeoGebra...')
  const [isGeoGebraReady, setIsGeoGebraReady] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [latestCommands, setLatestCommands] = useState<string[]>([])
  const [chatWidth, setChatWidth] = useState(360)
  const [isChatExpanded, setIsChatExpanded] = useState(true)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [mode, setMode] = useState<CopilotMode>('draw')
  const [authEmail, setAuthEmail] = useState('')
  const [authSession, setAuthSession] = useState<AuthSession | null>(null)
  const [plan, setPlan] = useState<Plan>('free')
  const [usageInfo, setUsageInfo] = useState<ConstructionResponse['usage']>(undefined)
  const [isAccountBusy, setIsAccountBusy] = useState(false)
  const appShellRef = useRef<HTMLElement | null>(null)
  const geogebraHostRef = useRef<HTMLDivElement | null>(null)
  const geogebraApiRef = useRef<GeoGebraApi | null>(null)
  const conversationEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = geogebraHostRef.current

    if (!host) {
      return
    }

    const cleanup = createGeoGebraApplet({
      host,
      onReady: (api) => {
        geogebraApiRef.current = api
        setIsGeoGebraReady(true)
        setStatusText('')
      },
      onError: (error) => {
        setIsGeoGebraReady(false)
        setStatusText(error.message)
      },
    })

    return () => {
      geogebraApiRef.current = null
      cleanup()
    }
  }, [])

  const addMessage = useCallback((message: Omit<Message, 'id'>) => {
    setMessages((current) => [
      ...current,
      { ...message, id: crypto.randomUUID() },
    ])
  }, [])

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const runCommands = useCallback((commands: string[]) => {
    const api = geogebraApiRef.current

    if (!api) {
      setStatusText('GeoGebra ainda nao esta pronto.')
      return null
    }

    const result = executeGeoGebraCommands(api, commands)

    if (result.failed.length > 0) {
      setStatusText(`${result.failed.length} erro(s) ao executar comandos GeoGebra.`)
      return result
    }

    setStatusText('')
    return result
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      return
    }

    let ignore = false

    async function loadSession() {
      try {
        const checkoutStatus = readCheckoutStatus()
        const sessionFromUrl = await readSessionFromUrl()
        const storedSession = sessionFromUrl ?? readStoredSession()
        const session = storedSession ? await refreshSession(storedSession) : null

        if (checkoutStatus === 'cancel' && !ignore) {
          setStatusText('Assinatura cancelada antes do pagamento.')
          clearCheckoutStatus()
        }

        if (!session || ignore) {
          if (!session && checkoutStatus === 'success' && !ignore) {
            setStatusText('Pagamento recebido. Entre novamente para atualizar seu plano.')
            clearCheckoutStatus()
          }
          return
        }

        setAuthSession(session)
        setAuthEmail(session.user.email ?? '')
        const nextPlan = await refreshPlanAfterCheckout(
          session.accessToken,
          session.user.id,
          checkoutStatus,
          () => ignore,
        )

        if (ignore) {
          return
        }

        setPlan(nextPlan)

        if (checkoutStatus === 'success') {
          setStatusText(
            nextPlan === 'pro'
              ? 'Plano Pro ativado.'
              : 'Pagamento recebido. Estamos aguardando a confirmacao do Stripe.',
          )
          clearCheckoutStatus()
        }
      } catch (error) {
        clearStoredSession()
        if (!ignore) {
          const message = error instanceof Error ? error.message : 'Erro ao carregar sessao.'
          setStatusText(message)
        }
      }
    }

    void loadSession()

    return () => {
      ignore = true
    }
  }, [])

  const focusGeoGebraFromPointer = useCallback(() => {
    const activeElement = document.activeElement

    if (activeElement instanceof HTMLElement && activeElement.closest('.copilotPane')) {
      activeElement.blur()
    }

    const host = geogebraHostRef.current
    const frame = host?.querySelector('iframe')

    if (frame instanceof HTMLIFrameElement) {
      frame.focus()
      return
    }

    host?.focus()
  }, [])

  const submitPrompt = async (prompt: string) => {
    const trimmedPrompt = prompt.trim()

    if (!trimmedPrompt || isSubmitting) {
      return
    }

    if (isBackendAiConfigured() && !authSession) {
      setStatusText('Entre com seu email para usar o Copilot.')
      return
    }

    if (mode === 'solve' && plan !== 'pro') {
      setStatusText('Resolver e um recurso Pro. Assine para liberar a IA de resolucao.')
      return
    }

    setInput('')
    setIsSubmitting(true)
    addMessage({ from: 'user', text: trimmedPrompt })

    try {
      const response = await requestConstruction(trimmedPrompt, {
        accessToken: authSession?.accessToken,
        mode,
      })
      setUsageInfo(response.usage)

      if (response.commands.length === 0) {
        setLatestCommands([])
        setStatusText('')
        addMessage({ from: 'copilot', text: formatCopilotResponse(response, null, showDebug) })
        return
      }

      const parsed = normalizeGeoGebraBlock(response.commands.join('\n'))

      if (parsed.errors.length > 0) {
        setStatusText(`${parsed.errors.length} erro(s) ao normalizar comandos GeoGebra.`)
        addMessage({ from: 'copilot', text: formatParsedGeoGebraDebug(parsed) })
        return
      }

      const result = runCommands(parsed.commands)
      setLatestCommands(parsed.commands)
      addMessage({
        from: 'copilot',
        text: formatCopilotResponse(response, parsed, showDebug),
      })

      if (showDebug && result && hasGeoGebraDebug(result)) {
        addMessage({ from: 'copilot', text: formatGeoGebraDebug(result) })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro desconhecido'
      setStatusText(message)
      addMessage({ from: 'copilot', text: message })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submitPrompt(input)
  }

  const handleLogin = async () => {
    const email = authEmail.trim()

    if (!email || isAccountBusy) {
      return
    }

    setIsAccountBusy(true)

    try {
      await requestMagicLink(email)
      setStatusText('Link de login enviado para seu email.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao enviar login.'
      setStatusText(message)
    } finally {
      setIsAccountBusy(false)
    }
  }

  const handleSignOut = async () => {
    if (!authSession || isAccountBusy) {
      return
    }

    setIsAccountBusy(true)

    try {
      await signOut(authSession.accessToken)
    } finally {
      clearStoredSession()
      setAuthSession(null)
      setPlan('free')
      setUsageInfo(undefined)
      setIsAccountBusy(false)
    }
  }

  const handleUpgrade = async () => {
    if (!authSession || isAccountBusy) {
      return
    }

    setIsAccountBusy(true)

    try {
      await createCheckoutSession(authSession.accessToken)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao abrir assinatura.'
      setStatusText(message)
      setIsAccountBusy(false)
    }
  }

  const handleBillingPortal = async () => {
    if (!authSession || isAccountBusy) {
      return
    }

    setIsAccountBusy(true)

    try {
      await createBillingPortalSession(authSession.accessToken)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao abrir cobranca.'
      setStatusText(message)
      setIsAccountBusy(false)
    }
  }

  const handleRefreshPlan = async () => {
    if (!authSession || isAccountBusy) {
      return
    }

    setIsAccountBusy(true)

    try {
      const nextPlan = await fetchPlan(authSession.accessToken, authSession.user.id)
      setPlan(nextPlan)
      setStatusText(nextPlan === 'pro' ? 'Plano Pro ativo.' : 'Plano Free ativo.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao atualizar plano.'
      setStatusText(message)
    } finally {
      setIsAccountBusy(false)
    }
  }

  const handleModeChange = (nextMode: CopilotMode) => {
    if (nextMode === 'solve' && plan !== 'pro') {
      setStatusText('Resolver e um recurso Pro. Assine para liberar a IA de resolucao.')
      return
    }

    setMode(nextMode)
  }

  const handleClearConstruction = () => {
    if (!clearGeoGebraConstruction(geogebraApiRef.current)) {
      setStatusText('GeoGebra ainda nao esta pronto.')
      return
    }

    setLatestCommands([])
    setStatusText('Construcao limpa.')
  }

  const handleClearConversation = () => {
    setMessages([])
    setStatusText('')
  }

  const handleCopyCommands = async () => {
    if (latestCommands.length === 0) {
      setStatusText('Nenhum comando gerado ainda.')
      return
    }

    try {
      await navigator.clipboard.writeText(latestCommands.join('\n'))
      setCopyStatus('copied')
      window.setTimeout(() => setCopyStatus('idle'), 1400)
    } catch {
      setCopyStatus('failed')
      setStatusText('Nao foi possivel copiar os comandos.')
      window.setTimeout(() => setCopyStatus('idle'), 1800)
    }
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const shell = appShellRef.current

    if (!shell) {
      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)

    const resize = (moveEvent: PointerEvent) => {
      const rect = shell.getBoundingClientRect()
      const nextWidth = rect.right - moveEvent.clientX
      const maxWidth = Math.min(560, rect.width - 360)
      setChatWidth(Math.min(Math.max(nextWidth, 300), Math.max(maxWidth, 300)))
    }

    const stopResize = () => {
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', stopResize)
    }

    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', stopResize)
  }

  return (
    <main
      ref={appShellRef}
      className={`appShell ${isChatExpanded ? '' : 'chatCollapsed'}`}
      style={{ '--chat-width': `${chatWidth}px` } as CSSProperties}
    >
      <section
        className="geogebraPane"
        aria-label="GeoGebra Geometry"
        onPointerDown={focusGeoGebraFromPointer}
        onPointerEnter={focusGeoGebraFromPointer}
      >
        <div ref={geogebraHostRef} className="geogebraHost" tabIndex={-1} />
        {!isGeoGebraReady && statusText ? (
          <div className="geoStatus">{statusText}</div>
        ) : null}
      </section>

      <div className="paneResizeHandle" onPointerDown={startResize} aria-hidden="true" />

      <aside className={`copilotPane ${isChatExpanded ? '' : 'copilotPaneCollapsed'}`} aria-label="Copilot">
        <header className="copilotHeader">
          <div className="copilotBrand">
            <img src="/ggb_copilot_logo.png" alt="" className="copilotLogo" />
            <span>Copilot</span>
          </div>
          <div className="copilotActions" aria-label="Acoes">
            <button
              type="button"
              className="toolButton mobileOnly mobileToggleButton"
              onClick={() => setIsChatExpanded((current) => !current)}
              aria-expanded={isChatExpanded}
              aria-label={isChatExpanded ? 'Ocultar chat' : 'Mostrar chat'}
              title={isChatExpanded ? 'Ocultar chat' : 'Mostrar chat'}
            >
              {isChatExpanded ? 'Ocultar' : 'Chat'}
            </button>
            <button
              type="button"
              className="toolButton clearGeoButton"
              onClick={handleClearConstruction}
              disabled={!isGeoGebraReady}
              aria-label="Limpar desenho"
              title="Limpar desenho"
            >
              Desenho
            </button>
            <button
              type="button"
              className="toolButton clearChatButton"
              onClick={handleClearConversation}
              disabled={messages.length === 0}
              aria-label="Limpar chat"
              title="Limpar chat"
            >
              Chat
            </button>
            <button
              type="button"
              className="toolButton copyCommandsButton"
              onClick={handleCopyCommands}
              disabled={latestCommands.length === 0}
              aria-label="Copiar comandos"
              title="Copiar comandos"
            >
              {copyStatus === 'copied' ? 'Copiado' : 'Copiar'}
            </button>
            <label className="debugToggle" title="Mostrar comandos GeoGebra gerados">
              <input
                type="checkbox"
                checked={showDebug}
                onChange={(event) => setShowDebug(event.target.checked)}
              />
              Comandos
            </label>
          </div>
        </header>
        <section className="modeSwitch" aria-label="Modo do Copilot">
          <button
            type="button"
            className={mode === 'draw' ? 'modeButton active' : 'modeButton'}
            onClick={() => handleModeChange('draw')}
          >
            Desenhar
          </button>
          <button
            type="button"
            className={mode === 'solve' ? 'modeButton active' : 'modeButton proModeButton'}
            onClick={() => handleModeChange('solve')}
            title={plan === 'pro' ? 'Resolver problema' : 'Disponivel no Pro'}
          >
            Resolver
            {plan !== 'pro' ? <span>Pro</span> : null}
          </button>
        </section>
        <section className="accountStrip" aria-label="Conta">
          {authSession ? (
            <>
              <div className="accountIdentity">
                <span>{authSession.user.email ?? 'Conta'}</span>
                <strong>{formatPlanLabel(plan, usageInfo)}</strong>
              </div>
              <button
                type="button"
                onClick={handleRefreshPlan}
                disabled={isAccountBusy}
                title="Atualizar plano"
              >
                Atualizar
              </button>
              {plan === 'pro' ? (
                <button
                  type="button"
                  onClick={handleBillingPortal}
                  disabled={isAccountBusy || !isCheckoutConfigured()}
                >
                  Gerenciar
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleUpgrade}
                  disabled={isAccountBusy || !isCheckoutConfigured()}
                >
                  Assinar Pro
                </button>
              )}
              <button type="button" onClick={handleSignOut} disabled={isAccountBusy}>
                Sair
              </button>
            </>
          ) : (
            <>
              {isSupabaseConfigured() ? (
                <>
                  <input
                    type="email"
                    value={authEmail}
                    onChange={(event) => setAuthEmail(event.target.value)}
                    placeholder="email"
                    disabled={isAccountBusy}
                  />
                  <button
                    type="button"
                    onClick={handleLogin}
                    disabled={isAccountBusy || !authEmail.trim()}
                  >
                    Entrar
                  </button>
                </>
              ) : (
                <span className="accountUnavailable">Login requer Supabase</span>
              )}
            </>
          )}
        </section>
        <div className="conversation">
          {messages.length === 0 ? (
            <div className="emptyState">
              <strong>{mode === 'draw' ? 'Comece com um pedido de geometria' : 'Resolva com a IA Pro'}</strong>
              {mode === 'solve' && plan !== 'pro' ? (
                <div className="proCallout">
                  <span>Resolver usa a IA mais forte para explicar passos e criar a construcao quando ajudar.</span>
                  <button
                    type="button"
                    onClick={handleUpgrade}
                    disabled={!authSession || isAccountBusy || !isCheckoutConfigured()}
                  >
                    Assinar Pro
                  </button>
                </div>
              ) : null}
              <div className="examplePrompts">
                {EXAMPLE_PROMPTS[mode].map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setInput(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {messages.map((message) => (
            <article key={message.id} className={`message message-${message.from}`}>
              <strong>{message.from === 'user' ? 'Voce' : 'Copilot'}</strong>
              <p>{message.text}</p>
            </article>
          ))}
          <div ref={conversationEndRef} />
        </div>
        {isGeoGebraReady && statusText ? (
          <p className="statusMessage">{statusText}</p>
        ) : null}
        {showDebug && latestCommands.length > 0 ? (
          <pre className="commandsDebug">{latestCommands.join('\n')}</pre>
        ) : null}
        <form className="promptForm" onSubmit={handleSubmit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Descreva a construcao ou o problema..."
            rows={3}
            disabled={isSubmitting}
          />
          <button
            type="submit"
            aria-label="Enviar"
            title="Enviar"
            disabled={isSubmitting || input.trim().length === 0}
          >
            {isSubmitting ? <span className="sendPending" /> : <span className="sendIcon" />}
          </button>
        </form>
      </aside>
    </main>
  )
}

function hasGeoGebraDebug(result: CommandExecutionResult) {
  return result.failed.length > 0 || result.warnings.length > 0
}

async function refreshPlanAfterCheckout(
  accessToken: string,
  userId: string,
  checkoutStatus: CheckoutStatus,
  shouldStop: () => boolean,
) {
  let nextPlan = await fetchPlan(accessToken, userId)

  if (checkoutStatus !== 'success' || nextPlan === 'pro') {
    return nextPlan
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await delay(1500)

    if (shouldStop()) {
      return nextPlan
    }

    nextPlan = await fetchPlan(accessToken, userId)

    if (nextPlan === 'pro') {
      return nextPlan
    }
  }

  return nextPlan
}

type CheckoutStatus = 'success' | 'cancel' | null

function readCheckoutStatus(): CheckoutStatus {
  const value = new URLSearchParams(window.location.search).get('checkout')
  return value === 'success' || value === 'cancel' ? value : null
}

function clearCheckoutStatus() {
  const url = new URL(window.location.href)
  url.searchParams.delete('checkout')
  window.history.replaceState(null, document.title, url.pathname + url.search + url.hash)
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function formatPlanLabel(plan: Plan, usage: ConstructionResponse['usage']) {
  if (plan === 'pro') {
    return 'Pro'
  }

  if (typeof usage?.remainingToday === 'number') {
    return `Free - ${usage.remainingToday} restantes`
  }

  return 'Free'
}

function formatCompiledGeoGebraCommands(parsed: NormalizeResult) {
  const sections: string[] = []

  if (parsed.warnings.length > 0) {
    sections.push(parsed.warnings.join('\n'))
  }

  sections.push(`Comandos GeoGebra gerados:\n\n\`\`\`geogebra\n${parsed.commands.join('\n')}\n\`\`\``)
  return sections.filter(Boolean).join('\n\n')
}

function formatCopilotResponse(
  response: ConstructionResponse,
  parsed: NormalizeResult | null,
  showDebug: boolean,
) {
  const sections: string[] = []

  sections.push(response.explanation || (parsed ? 'Construcao aplicada.' : 'Resposta concluida.'))

  if (showDebug && parsed) {
    sections.push(formatCompiledGeoGebraCommands(parsed))
    sections.push(
      [
        `Provider: ${response.debug.provider}`,
        `Modelo: ${response.debug.model}`,
        `Modo: ${response.debug.mode ?? 'draw'}`,
        `Reparo: ${response.debug.repaired ? 'sim' : 'nao'}`,
      ].join('\n'),
    )
  } else if (showDebug) {
    sections.push(
      [
        `Provider: ${response.debug.provider}`,
        `Modelo: ${response.debug.model}`,
        `Modo: ${response.debug.mode ?? 'solve'}`,
        `Reparo: ${response.debug.repaired ? 'sim' : 'nao'}`,
      ].join('\n'),
    )
  }

  return sections.join('\n\n')
}

function formatParsedGeoGebraDebug(parsed: NormalizeResult) {
  const sections: string[] = []

  if (parsed.errors.length > 0) {
    sections.push(`Erros de normalizacao (${parsed.errors.length}):\n\n${parsed.errors.join('\n')}`)
  }

  if (parsed.warnings.length > 0) {
    sections.push(`Avisos (${parsed.warnings.length}):\n\n${parsed.warnings.join('\n')}`)
  }

  if (parsed.commands.length > 0) {
    sections.push(`Comandos normalizados:\n\n\`\`\`geogebra\n${parsed.commands.join('\n')}\n\`\`\``)
  }

  return sections.join('\n\n')
}

function formatGeoGebraDebug(result: CommandExecutionResult) {
  const sections: string[] = []
  const validationFailures = result.failed.filter((failure) => failure.kind === 'validation')
  const geogebraFailures = result.failed.filter((failure) => failure.kind === 'geogebra')

  if (validationFailures.length > 0) {
    const errors = validationFailures
      .map(
        (failure) =>
          `Linha ${failure.line}: ${failure.message}\n${failure.command}`,
      )
      .join('\n\n')

    sections.push(`Erros de validação (${validationFailures.length}):\n\n${errors}`)
  }

  if (geogebraFailures.length > 0) {
    const errors = geogebraFailures
      .map((failure) => `Linha ${failure.line}: ${failure.message}\n${failure.command}`)
      .join('\n\n')

    sections.push(`Erros do GeoGebra (${geogebraFailures.length}):\n\n${errors}`)
  }

  if (result.warnings.length > 0) {
    sections.push(`Avisos (${result.warnings.length}):\n\n${result.warnings.join('\n')}`)
  }

  return sections.join('\n\n')
}

export default App
