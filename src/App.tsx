import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import {
  ArrowUp,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CreditCard,
  LogIn,
  LogOut,
  Sparkles,
  SquarePen,
} from 'lucide-react'
import {
  requestChatTitle,
  requestConstruction,
  type CopilotMode,
} from './ai'
import {
  createGeoGebraApplet,
  executeGeoGebraCommands,
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
  isProPlan,
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

type ChatThread = {
  id: string
  title: string
  isTitlePending: boolean
  messages: Message[]
  updatedAt: number
}

type ChatState = {
  threads: ChatThread[]
  activeChatId: string
}

const CHAT_STORAGE_KEY = 'ggb-copilot:chat-state'
const INITIAL_CHAT_STATE = readInitialChatState()

function App() {
  const [input, setInput] = useState('')
  const [chatThreads, setChatThreads] = useState<ChatThread[]>(() => INITIAL_CHAT_STATE.threads)
  const [activeChatId, setActiveChatId] = useState(() => INITIAL_CHAT_STATE.activeChatId)
  const [isChatListOpen, setIsChatListOpen] = useState(true)
  const [statusText, setStatusText] = useState('Carregando GeoGebra...')
  const [isGeoGebraReady, setIsGeoGebraReady] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [chatWidth, setChatWidth] = useState(360)
  const [isChatExpanded, setIsChatExpanded] = useState(true)
  const [mode, setMode] = useState<CopilotMode>('draw')
  const [authEmail, setAuthEmail] = useState('')
  const [authSession, setAuthSession] = useState<AuthSession | null>(null)
  const [plan, setPlan] = useState<Plan>('free')
  const [isAccountBusy, setIsAccountBusy] = useState(false)
  const appShellRef = useRef<HTMLElement | null>(null)
  const geogebraHostRef = useRef<HTMLDivElement | null>(null)
  const geogebraApiRef = useRef<GeoGebraApi | null>(null)
  const conversationEndRef = useRef<HTMLDivElement | null>(null)
  const currentChatId = activeChatId ?? chatThreads[0]?.id ?? ''
  const activeChat = chatThreads.find((thread) => thread.id === currentChatId) ?? chatThreads[0]
  const messages = activeChat?.messages ?? []
  const activeChatTitle = formatVisibleChatTitle(activeChat)
  const visibleChatThreads = [...chatThreads].sort((left, right) => right.updatedAt - left.updatedAt)

  useEffect(() => {
    storeChatState(chatThreads, currentChatId)
  }, [chatThreads, currentChatId])

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
    setChatThreads((current) => current.map((thread) => (
      thread.id === currentChatId
        ? {
          ...thread,
          messages: [
            ...thread.messages,
            { ...message, id: crypto.randomUUID() },
          ],
          updatedAt: Date.now(),
        }
        : thread
    )))
  }, [currentChatId])

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: 'end' })
  }, [currentChatId, messages.length])

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

  const submitPrompt = async (prompt: string) => {
    const trimmedPrompt = prompt.trim()

    if (!trimmedPrompt || isSubmitting) {
      return
    }

    if (isBackendAiConfigured() && !authSession) {
      setStatusText('Entre com seu email para usar o Copilot.')
      return
    }

    if (mode === 'solve' && !isProPlan(plan)) {
      setStatusText('Resolver e um recurso Pro. Assine para liberar a IA de resolucao.')
      return
    }

    const isFirstMessage = messages.length === 0

    setInput('')
    setIsSubmitting(true)
    setIsChatListOpen(false)
    setChatThreads((current) => current.map((thread) => (
      thread.id === currentChatId && isFirstMessage
        ? {
          ...thread,
          title: formatChatTitle(trimmedPrompt),
          isTitlePending: Boolean(authSession?.accessToken),
          updatedAt: Date.now(),
        }
        : thread
    )))

    if (isFirstMessage) {
      void updateChatTitleFromAi(currentChatId, trimmedPrompt, mode)
    }

    addMessage({ from: 'user', text: trimmedPrompt })

    try {
      const response = await requestConstruction(trimmedPrompt, {
        accessToken: authSession?.accessToken,
        mode,
      })

      if (response.commands.length === 0) {
        setStatusText('')
        addMessage({ from: 'copilot', text: formatCopilotResponse(response, null) })
        return
      }

      const parsed = normalizeGeoGebraBlock(response.commands.join('\n'))

      if (parsed.errors.length > 0) {
        setStatusText(`${parsed.errors.length} erro(s) ao normalizar comandos GeoGebra.`)
        addMessage({ from: 'copilot', text: formatParsedGeoGebraDebug(parsed) })
        return
      }

      runCommands(parsed.commands)
      addMessage({
        from: 'copilot',
        text: formatCopilotResponse(response, parsed),
      })
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

  const handlePromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
      return
    }

    event.preventDefault()
    void submitPrompt(input)
  }

  const handleAuthEmailKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    void handleLogin()
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
    if (isAccountBusy) {
      return
    }

    if (!authSession) {
      setStatusText('Entre com seu email para assinar o Pro.')
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

  const handleModeChange = (nextMode: CopilotMode) => {
    if (nextMode === 'solve' && !isProPlan(plan)) {
      setStatusText('Resolver e um recurso Pro. Assine para liberar a IA de resolucao.')
    }

    setMode(nextMode)
  }

  const handleNewChat = () => {
    const reusableThread = chatThreads.find((thread) => thread.messages.length === 0)

    if (reusableThread) {
      setActiveChatId(reusableThread.id)
      setInput('')
      setStatusText('')
      setIsChatListOpen(true)
      return
    }

    const nextThread = createChatThread()
    setChatThreads((current) => [nextThread, ...current])
    setActiveChatId(nextThread.id)
    setInput('')
    setStatusText('')
    setIsChatListOpen(true)
  }

  const handleOpenChat = (chatId: string) => {
    setActiveChatId(chatId)
    setInput('')
    setStatusText('')
    setIsChatListOpen(false)
  }

  const updateChatTitleFromAi = async (chatId: string, prompt: string, titleMode: CopilotMode) => {
    try {
      const title = await requestChatTitle(prompt, {
        accessToken: authSession?.accessToken,
        mode: titleMode,
      })

      setChatThreads((current) => current.map((thread) => (
        thread.id === chatId
          ? {
            ...thread,
            title,
            isTitlePending: false,
            updatedAt: Date.now(),
          }
          : thread
      )))
    } catch {
      setChatThreads((current) => current.map((thread) => (
        thread.id === chatId
          ? {
            ...thread,
            isTitlePending: false,
          }
          : thread
      )))
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
      <section className="geogebraPane" aria-label="GeoGebra Geometry">
        <div ref={geogebraHostRef} className="geogebraHost" />
        {!isGeoGebraReady && statusText ? (
          <div className="geoStatus">{statusText}</div>
        ) : null}
      </section>

      <div className="paneResizeHandle" onPointerDown={startResize} aria-hidden="true" />

      <aside className={`copilotPane ${isChatExpanded ? '' : 'copilotPaneCollapsed'}`} aria-label="Copilot">
        <header className="copilotHeader">
          {isChatListOpen ? (
            <div className="copilotBrand">
              <span className="copilotDot" aria-hidden="true" />
              <span>Copilot</span>
            </div>
          ) : (
            <div className="chatTitleBar">
              <button
                type="button"
                className="iconButton backButton"
                onClick={() => setIsChatListOpen(true)}
                aria-label="Voltar para chats"
                title="Voltar para chats"
              >
                <ArrowLeft size={17} strokeWidth={2} aria-hidden="true" />
              </button>
              <span className="chatTitleText" title={activeChatTitle}>{activeChatTitle}</span>
            </div>
          )}
          <div className="copilotActions" aria-label="Acoes">
            <button
              type="button"
              className="iconButton"
              onClick={handleNewChat}
              aria-label="Novo chat"
              title="Novo chat"
            >
              <SquarePen size={17} strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="iconButton mobileOnly"
              onClick={() => setIsChatExpanded((current) => !current)}
              aria-expanded={isChatExpanded}
              aria-label={isChatExpanded ? 'Ocultar chat' : 'Mostrar chat'}
              title={isChatExpanded ? 'Ocultar chat' : 'Mostrar chat'}
            >
              {isChatExpanded ? (
                <ChevronDown size={17} strokeWidth={2} aria-hidden="true" />
              ) : (
                <ChevronUp size={17} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
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
            className={mode === 'solve' ? 'modeButton active' : 'modeButton'}
            onClick={() => handleModeChange('solve')}
            title={isProPlan(plan) ? 'Resolver problema' : 'Disponivel no Pro'}
          >
            Resolver
            {!isProPlan(plan) ? <span>Pro</span> : null}
          </button>
        </section>
        <section className="accountStrip" aria-label="Conta">
          {authSession ? (
            <>
              <div className="accountIdentity">
                <span>{authSession.user.email ?? 'Conta'}</span>
                <strong>{formatPlanLabel(plan)}</strong>
              </div>
              {isProPlan(plan) ? (
                <button
                  type="button"
                  onClick={handleBillingPortal}
                  disabled={isAccountBusy || !isCheckoutConfigured()}
                  aria-label="Gerenciar assinatura"
                  title="Gerenciar assinatura"
                >
                  <CreditCard size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleUpgrade}
                  disabled={isAccountBusy || !isCheckoutConfigured()}
                  aria-label="Assinar Pro"
                  title="Assinar Pro"
                >
                  <Sparkles size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={handleSignOut}
                disabled={isAccountBusy}
                aria-label="Sair"
                title="Sair"
              >
                <LogOut size={15} strokeWidth={2} aria-hidden="true" />
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
                    onKeyDown={handleAuthEmailKeyDown}
                    placeholder="email"
                    disabled={isAccountBusy}
                  />
                  <button
                    type="button"
                    onClick={handleLogin}
                    disabled={isAccountBusy || !authEmail.trim()}
                    aria-label="Entrar"
                    title="Entrar"
                  >
                    {isAccountBusy ? (
                      <span className="buttonPending" />
                    ) : (
                      <LogIn size={15} strokeWidth={2} aria-hidden="true" />
                    )}
                  </button>
                </>
              ) : (
                <span className="accountUnavailable">Login requer Supabase</span>
              )}
            </>
          )}
        </section>
        <div className={isChatListOpen ? 'conversation conversation-history' : 'conversation'}>
          {isChatListOpen ? (
            <section className="chatHistory" aria-label="Historico de chats">
              <div className="chatHistoryHeader">
                <strong>Chats</strong>
              </div>
              <div className="chatHistoryList">
                {visibleChatThreads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={thread.id === currentChatId ? 'chatHistoryItem active' : 'chatHistoryItem'}
                    onClick={() => handleOpenChat(thread.id)}
                    title={thread.title}
                  >
                    <span>{thread.isTitlePending ? 'Gerando titulo...' : thread.title}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <>
              {messages.map((message) => (
                <article key={message.id} className={`message message-${message.from}`}>
                  <strong>{message.from === 'user' ? 'Voce' : 'Copilot'}</strong>
                  <p>{message.text}</p>
                </article>
              ))}
              <div ref={conversationEndRef} />
            </>
          )}
        </div>
        {isGeoGebraReady && statusText ? (
          <p className={`statusMessage status-${readStatusTone(statusText)}`}>{statusText}</p>
        ) : null}
        <form className="promptForm" onSubmit={handleSubmit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            placeholder={mode === 'draw' ? 'Descreva a construcao...' : 'Digite o problema para resolver...'}
            rows={3}
            disabled={isSubmitting}
          />
          <button
            type="submit"
            aria-label="Enviar"
            title="Enviar"
            disabled={isSubmitting || input.trim().length === 0}
          >
            {isSubmitting ? <span className="sendPending" /> : <ArrowUp size={17} strokeWidth={2.3} aria-hidden="true" />}
          </button>
        </form>
      </aside>
    </main>
  )
}

function readStatusTone(message: string) {
  const normalized = message.toLowerCase()

  if (
    normalized.includes('erro') ||
    normalized.includes('nao foi possivel') ||
    normalized.includes('falhou') ||
    normalized.includes('requer')
  ) {
    return 'error'
  }

  if (
    normalized.includes('ativado') ||
    normalized.includes('ativo') ||
    normalized.includes('enviado')
  ) {
    return 'success'
  }

  if (
    normalized.includes('aguardando') ||
    normalized.includes('cancelada') ||
    normalized.includes('assine') ||
    normalized.includes('entre com')
  ) {
    return 'warning'
  }

  return 'info'
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

function readInitialChatState(): ChatState {
  if (typeof window === 'undefined') {
    const thread = createChatThread()
    return { threads: [thread], activeChatId: thread.id }
  }

  try {
    const storedValue = window.localStorage.getItem(CHAT_STORAGE_KEY)

    if (!storedValue) {
      const thread = createChatThread()
      return { threads: [thread], activeChatId: thread.id }
    }

    const parsed = JSON.parse(storedValue) as Partial<ChatState>
    const threads = Array.isArray(parsed.threads)
      ? parsed.threads
        .map(normalizeStoredThread)
        .filter((thread): thread is ChatThread => thread !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt)
      : []

    if (threads.length === 0) {
      const thread = createChatThread()
      return { threads: [thread], activeChatId: thread.id }
    }

    const activeChatId = threads.some((thread) => thread.id === parsed.activeChatId)
      ? parsed.activeChatId!
      : threads[0].id

    return { threads, activeChatId }
  } catch {
    const thread = createChatThread()
    return { threads: [thread], activeChatId: thread.id }
  }
}

function storeChatState(threads: ChatThread[], activeChatId: string) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    CHAT_STORAGE_KEY,
    JSON.stringify({
      threads: threads.slice(0, 40),
      activeChatId,
    }),
  )
}

function normalizeStoredThread(thread: unknown): ChatThread | null {
  if (!thread || typeof thread !== 'object') {
    return null
  }

  const candidate = thread as Partial<ChatThread>

  if (typeof candidate.id !== 'string') {
    return null
  }

  return {
    id: candidate.id,
    title: typeof candidate.title === 'string' && candidate.title.trim()
      ? candidate.title
      : 'Novo chat',
    isTitlePending: candidate.isTitlePending === true,
    messages: Array.isArray(candidate.messages)
      ? candidate.messages.filter(isStoredMessage)
      : [],
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
  }
}

function isStoredMessage(message: unknown): message is Message {
  if (!message || typeof message !== 'object') {
    return false
  }

  const candidate = message as Partial<Message>
  return (
    typeof candidate.id === 'string' &&
    (candidate.from === 'user' || candidate.from === 'copilot') &&
    typeof candidate.text === 'string'
  )
}

function createChatThread(): ChatThread {
  return {
    id: crypto.randomUUID(),
    title: 'Novo chat',
    isTitlePending: false,
    messages: [],
    updatedAt: Date.now(),
  }
}

function formatChatTitle(prompt: string) {
  return prompt.length > 34 ? `${prompt.slice(0, 34).trim()}...` : prompt
}

function formatVisibleChatTitle(thread: ChatThread | undefined) {
  if (!thread) {
    return 'Novo chat'
  }

  return thread.isTitlePending ? 'Gerando titulo...' : thread.title
}

function formatPlanLabel(plan: Plan) {
  if (isProPlan(plan)) {
    return 'Pro'
  }

  return 'Free'
}

function formatCopilotResponse(
  response: Awaited<ReturnType<typeof requestConstruction>>,
  parsed: NormalizeResult | null,
) {
  const sections: string[] = []

  sections.push(response.explanation || (parsed ? 'Construcao aplicada.' : 'Resposta concluida.'))

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

export default App
