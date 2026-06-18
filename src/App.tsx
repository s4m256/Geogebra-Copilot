import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { requestConstruction } from './ai'
import {
  createGeoGebraApplet,
  executeGeoGebraCommands,
  type CommandExecutionResult,
  type GeoGebraApi,
} from './geogebra'
import { normalizeGeoGebraBlock, type NormalizeResult } from './lib/ggbCommandNormalizer'
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

    setInput('')
    setIsSubmitting(true)
    addMessage({ from: 'user', text: trimmedPrompt })

    try {
      const commands = await requestConstruction(trimmedPrompt)
      const parsed = normalizeGeoGebraBlock(commands.join('\n'))

      if (parsed.errors.length > 0) {
        setStatusText(`${parsed.errors.length} erro(s) ao normalizar comandos GeoGebra.`)
        addMessage({ from: 'copilot', text: formatParsedGeoGebraDebug(parsed) })
        return
      }

      const result = runCommands(parsed.commands)
      addMessage({ from: 'copilot', text: formatCompiledGeoGebraCommands(parsed) })

      if (result && hasGeoGebraDebug(result)) {
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

  return (
    <main className="appShell">
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

      <aside className="copilotPane" aria-label="Copilot">
        <header className="copilotHeader">Copilot</header>
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
        <form className="promptForm" onSubmit={handleSubmit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Descreva a construcao..."
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
