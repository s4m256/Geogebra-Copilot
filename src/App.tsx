import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent } from 'react'
import { requestConstruction, type ConstructionResponse } from './ai'
import {
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

function App() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [statusText, setStatusText] = useState('Carregando GeoGebra...')
  const [isGeoGebraReady, setIsGeoGebraReady] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [latestCommands, setLatestCommands] = useState<string[]>([])
  const [chatWidth, setChatWidth] = useState(360)
  const [authEmail, setAuthEmail] = useState('')
  const [authSession, setAuthSession] = useState<AuthSession | null>(null)
  const [plan, setPlan] = useState<Plan>('free')
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
        const sessionFromUrl = await readSessionFromUrl()
        const storedSession = sessionFromUrl ?? readStoredSession()
        const session = storedSession ? await refreshSession(storedSession) : null

        if (!session || ignore) {
          return
        }

        setAuthSession(session)
        setAuthEmail(session.user.email ?? '')
        setPlan(await fetchPlan(session.accessToken, session.user.id))
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

    setInput('')
    setIsSubmitting(true)
    addMessage({ from: 'user', text: trimmedPrompt })

    try {
      const response = await requestConstruction(trimmedPrompt, {
        accessToken: authSession?.accessToken,
      })
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
      className="appShell"
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

      <aside className="copilotPane" aria-label="Copilot">
        <header className="copilotHeader">
          <div className="copilotBrand">
            <img src="/ggb_copilot_logo.png" alt="" className="copilotLogo" />
            <span>Copilot</span>
          </div>
          <label className="debugToggle" title="Mostrar comandos GeoGebra gerados">
            <input
              type="checkbox"
              checked={showDebug}
              onChange={(event) => setShowDebug(event.target.checked)}
            />
            Comandos
          </label>
        </header>
        <section className="accountStrip" aria-label="Conta">
          {authSession ? (
            <>
              <div className="accountIdentity">
                <span>{authSession.user.email ?? 'Conta'}</span>
                <strong>{plan === 'pro' ? 'Pro' : 'Free'}</strong>
              </div>
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
  parsed: NormalizeResult,
  showDebug: boolean,
) {
  const sections: string[] = []

  sections.push(response.explanation || 'Construcao aplicada.')

  if (showDebug) {
    sections.push(formatCompiledGeoGebraCommands(parsed))
    sections.push(
      [
        `Provider: ${response.debug.provider}`,
        `Modelo: ${response.debug.model}`,
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
