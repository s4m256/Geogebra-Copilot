import { type CoordMap, type Point2D, planCollinearSegmentMerge } from './collinearSegments'

export type GeoGebraApi = {
  deleteObject?(name: string): void
  evalCommand(command: string): boolean
  getAllObjectNames?(objectType?: string): string[]
  getXcoord?(name: string): number
  getYcoord?(name: string): number
  setSize(width: number, height: number): void
  setVisible?(name: string, visible: boolean): void
}

type GeoGebraAppletInstance = {
  inject(hostId: string): void
}

type GeoGebraAppletParameters = {
  appName: 'geometry'
  id: string
  width: number
  height: number
  perspective: 'G'
  language: 'pt'
  showToolBar: boolean
  showToolBarHelp: boolean
  showMenuBar: boolean
  showAlgebraInput: boolean
  showResetIcon: boolean
  showZoomButtons: boolean
  showFullscreenButton: boolean
  showKeyboardOnFocus: boolean
  enableLabelDrags: boolean
  enableShiftDragZoom: boolean
  enableRightClick: boolean
  useBrowserForJS: boolean
  appletOnLoad(api: GeoGebraApi): void
}

type GeoGebraAppletConstructor = new (
  parameters: GeoGebraAppletParameters,
  preferHtml5?: boolean,
) => GeoGebraAppletInstance

type CreateAppletOptions = {
  host: HTMLDivElement
  onReady(api: GeoGebraApi): void
  onError(error: Error): void
}

export type CommandExecutionFailure = {
  kind: 'validation' | 'geogebra'
  line: number
  command: string
  message: string
  missingNames?: string[]
  nestedCommands?: string[]
}

export type CommandExecutionResult = {
  executed: string[]
  successfulCount: number
  failed: CommandExecutionFailure[]
  warnings: string[]
}

type ParsedCall = {
  name: string
  args: string[]
}

type CommandFallback = {
  command: string | null
  reason: string | null
}

declare global {
  interface Window {
    GGBApplet?: GeoGebraAppletConstructor
    geogebraApplet?: GeoGebraApi
  }
}

const DEPLOY_GGB_URL =
  import.meta.env.VITE_GEOGEBRA_DEPLOY_URL ??
  'https://www.geogebra.org/apps/deployggb.js'
const HOST_ID = 'geogebra-host'
const APPLET_ID = 'geogebraApplet'
const APPLET_READY_TIMEOUT_MS = 20000
const GEOGEBRA_COMMAND_NAMES = new Set([
  'Angle',
  'AngleBisector',
  'Arc',
  'Area',
  'AreCollinear',
  'AreConcurrent',
  'AreConcyclic',
  'AreParallel',
  'ArePerpendicular',
  'Circle',
  'Distance',
  'Incircle',
  'Intersect',
  'Length',
  'Line',
  'Midpoint',
  'ParallelLine',
  'PerpendicularBisector',
  'PerpendicularLine',
  'Point',
  'Polygon',
  'Ray',
  'Reflect',
  'Rotate',
  'Segment',
  'Tangent',
  'Translate',
  'TriangleCenter',
  'Vector',
  'Vertex',
])
const GEOGEBRA_RESERVED_IDENTIFIERS = new Set(['pi', 'e', 'true', 'false'])

let scriptPromise: Promise<void> | null = null

export function createGeoGebraApplet(options: CreateAppletOptions) {
  const { host, onReady, onError } = options
  let disposed = false
  let ready = false
  let resizeObserver: ResizeObserver | null = null
  let resizeAnimationFrame = 0
  let resizeTimer = 0
  let readyTimer = 0
  let resizeListener: (() => void) | null = null

  host.id = HOST_ID
  host.replaceChildren()

  void loadGeoGebraScript()
    .then(() => {
      if (disposed || !window.GGBApplet) {
        return
      }

      const initialSize = getHostSize(host)
      const parameters: GeoGebraAppletParameters = {
        appName: 'geometry',
        id: APPLET_ID,
        width: initialSize.width,
        height: initialSize.height,
        perspective: 'G',
        language: 'pt',
        showToolBar: true,
        showToolBarHelp: true,
        showMenuBar: false,
        showAlgebraInput: false,
        showResetIcon: true,
        showZoomButtons: true,
        showFullscreenButton: true,
        showKeyboardOnFocus: true,
        enableLabelDrags: true,
        enableShiftDragZoom: true,
        enableRightClick: true,
        useBrowserForJS: true,
        appletOnLoad: markReady,
      }

      readyTimer = window.setTimeout(() => {
        if (!ready) {
          onError(new Error('GeoGebra loaded, but the applet did not become ready.'))
        }
      }, APPLET_READY_TIMEOUT_MS)

      new window.GGBApplet(parameters, true).inject(HOST_ID)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'GeoGebra failed to load'
      onError(new Error(message))
    })

  function markReady(api: GeoGebraApi) {
    if (disposed || ready) {
      return
    }

    ready = true
    window.clearTimeout(readyTimer)

    function syncSize() {
      if (disposed) {
        return
      }

      const size = getHostSize(host)
      if (size.width === 0 || size.height === 0) {
        return
      }

      api.setSize(size.width, size.height)
      syncInjectedAppletSize(host)
    }

    function scheduleResize() {
      window.cancelAnimationFrame(resizeAnimationFrame)
      resizeAnimationFrame = window.requestAnimationFrame(syncSize)
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(syncSize, 120)
    }

    resizeListener = scheduleResize
    resizeObserver = new ResizeObserver(scheduleResize)
    resizeObserver.observe(host)
    window.addEventListener('resize', scheduleResize)
    document.addEventListener('fullscreenchange', scheduleResize)
    scheduleResize()
    onReady(api)
  }

  return () => {
    disposed = true
    window.clearTimeout(readyTimer)
    window.cancelAnimationFrame(resizeAnimationFrame)
    window.clearTimeout(resizeTimer)
    resizeObserver?.disconnect()

    if (resizeListener) {
      window.removeEventListener('resize', resizeListener)
      document.removeEventListener('fullscreenchange', resizeListener)
    }

    host.replaceChildren()
  }
}

function getHostSize(host: HTMLElement) {
  const rect = host.getBoundingClientRect()
  const width = Math.max(
    Math.floor(rect.width || host.clientWidth || host.offsetWidth),
    320,
  )
  const height = Math.max(
    Math.floor(rect.height || host.clientHeight || host.offsetHeight),
    240,
  )

  return {
    width,
    height,
  }
}

function syncInjectedAppletSize(host: HTMLElement) {
  const injectedElements: HTMLElement[] = []

  for (const child of host.children) {
    if (child instanceof HTMLElement) {
      injectedElements.push(child)
    }
  }

  const iframe = host.querySelector<HTMLIFrameElement>('iframe')
  if (iframe) {
    injectedElements.push(iframe)
  }

  const appletRoot = host.querySelector<HTMLElement>(`#${APPLET_ID}`)
  if (appletRoot) {
    injectedElements.push(appletRoot)
  }

  for (const element of injectedElements) {
    element.style.setProperty('width', '100%', 'important')
    element.style.setProperty('height', '100%', 'important')
    element.style.setProperty('max-width', '100%')
    element.style.setProperty('max-height', '100%')
  }
}

export function executeGeoGebraCommands(
  api: GeoGebraApi,
  commands: string[],
): CommandExecutionResult {
  const result: CommandExecutionResult = {
    executed: [],
    successfulCount: 0,
    failed: [],
    warnings: [],
  }
  const validationFailures = validateCommandDependencies(commands)
  const definitions = new Map<string, ParsedCall>()
  const pointDefinitions = new Map<string, Point2D>()

  if (validationFailures.length > 0) {
    return { ...result, failed: validationFailures }
  }

  clearExistingObjects(api)

  for (const [index, command] of commands.entries()) {
    try {
      const precomputedLineIntersection = getLineLineIntersectionFallback(
        api,
        definitions,
        pointDefinitions,
        command,
      )

      if (precomputedLineIntersection.command) {
        const label = parseAssignment(command).lhs

        if (label) {
          deleteObject(api, label)
        }

        const precomputedOk = api.evalCommand(precomputedLineIntersection.command)

        if (precomputedOk) {
          result.executed.push(precomputedLineIntersection.command)
          result.successfulCount = result.executed.length
          result.warnings.push(`Computed line-line intersection: ${precomputedLineIntersection.command}`)
          rememberCommandDefinition(precomputedLineIntersection.command, definitions, pointDefinitions)
          continue
        }

        result.warnings.push(
          `GeoGebra rejected computed line-line fallback: ${precomputedLineIntersection.command}`,
        )
      }

      const ok = api.evalCommand(command)

      if (!ok) {
        const numericFallbackCommand = getLineCircleIntersectionFallback(
          api,
          definitions,
          pointDefinitions,
          command,
        )

        if (numericFallbackCommand) {
          const label = parseAssignment(command).lhs

          if (label) {
            deleteObject(api, label)
          }

          const numericFallbackOk = api.evalCommand(numericFallbackCommand)

          if (numericFallbackOk) {
            result.executed.push(numericFallbackCommand)
            result.successfulCount = result.executed.length
            result.warnings.push(`Computed line-circle intersection: ${numericFallbackCommand}`)
            rememberCommandDefinition(numericFallbackCommand, definitions, pointDefinitions)
            continue
          }
        }

        const lineFallback = getLineLineIntersectionFallback(
          api,
          definitions,
          pointDefinitions,
          command,
        )

        if (lineFallback.command) {
          const label = parseAssignment(command).lhs

          if (label) {
            deleteObject(api, label)
          }

          const lineFallbackOk = api.evalCommand(lineFallback.command)

          if (lineFallbackOk) {
            result.executed.push(lineFallback.command)
            result.successfulCount = result.executed.length
            result.warnings.push(`Computed line-line intersection: ${lineFallback.command}`)
            rememberCommandDefinition(lineFallback.command, definitions, pointDefinitions)
            continue
          }

          result.warnings.push(`GeoGebra rejected computed line-line fallback: ${lineFallback.command}`)
        } else if (lineFallback.reason) {
          result.warnings.push(lineFallback.reason)
        }

        const fallbackCommands = getIndexedIntersectFallbacks(command)
        let fallbackSucceeded = false

        for (const fallbackCommand of fallbackCommands) {
          const fallbackOk = api.evalCommand(fallbackCommand)

          if (fallbackOk) {
            result.executed.push(fallbackCommand)
            result.successfulCount = result.executed.length
            result.warnings.push(`Adjusted indexed intersection: ${fallbackCommand}`)
            rememberCommandDefinition(fallbackCommand, definitions, pointDefinitions)
            fallbackSucceeded = true
            break
          }
        }

        if (fallbackSucceeded) {
          continue
        }

        result.failed.push({
          kind: 'geogebra',
          line: index + 1,
          command,
          message: 'GeoGebra rejected the command.',
        })
        break
      }

      result.executed.push(command)
      result.successfulCount = result.executed.length
      rememberCommandDefinition(command, definitions, pointDefinitions)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Command failed.'
      result.failed.push({ kind: 'geogebra', line: index + 1, command, message })
      break
    }
  }

  if (result.failed.length === 0) {
    result.warnings.push(...mergeCollinearSegmentsInApplet(api, result.executed))
    hideAuxiliaryObjects(api)
  }

  return result
}

function getLineLineIntersectionFallback(
  api: GeoGebraApi,
  definitions: Map<string, ParsedCall>,
  pointDefinitions: Map<string, Point2D>,
  command: string,
): CommandFallback {
  const assignment = parseAssignment(command)
  const call = assignment.lhs ? parseCallExpression(assignment.rhs) : null

  if (!assignment.lhs || call?.name !== 'Intersect' || call.args.length !== 2) {
    return { command: null, reason: null }
  }

  const firstLine = readLinePoints(api, definitions, pointDefinitions, call.args[0])

  if (!firstLine) {
    return {
      command: null,
      reason: `Fallback linha-linha nao conseguiu ler a reta ${call.args[0]}.`,
    }
  }

  const secondLine = readLinePoints(api, definitions, pointDefinitions, call.args[1])

  if (!secondLine) {
    return {
      command: null,
      reason: `Fallback linha-linha nao conseguiu ler a reta ${call.args[1]}.`,
    }
  }

  const point = intersectLines(firstLine.start, firstLine.end, secondLine.start, secondLine.end)

  if (!point) {
    return {
      command: null,
      reason: `Fallback linha-linha detectou retas paralelas ou coincidentes: ${command}`,
    }
  }

  return {
    command: `${assignment.lhs} = (${formatCoordinate(point.x)}, ${formatCoordinate(point.y)})`,
    reason: null,
  }
}

function getIndexedIntersectFallbacks(command: string) {
  const parsed = parseIndexedIntersectCommand(command)

  if (!parsed) {
    return []
  }

  const alternateIndex = parsed.index === 1 ? '2' : '1'
  const fallbackCommands = [
    `${parsed.label} = Intersect(${parsed.first}, ${parsed.second})`,
    `${parsed.label} = Intersect(${parsed.second}, ${parsed.first})`,
    `${parsed.label} = Intersect(${parsed.second}, ${parsed.first}, ${parsed.index})`,
    `${parsed.label} = Intersect(${parsed.first}, ${parsed.second}, ${alternateIndex})`,
    `${parsed.label} = Intersect(${parsed.second}, ${parsed.first}, ${alternateIndex})`,
  ]

  return Array.from(new Set(fallbackCommands)).filter((fallback) => fallback !== command)
}

function getLineCircleIntersectionFallback(
  api: GeoGebraApi,
  definitions: Map<string, ParsedCall>,
  pointDefinitions: Map<string, Point2D>,
  command: string,
) {
  const parsed = parseIndexedIntersectCommand(command)

  if (!parsed) {
    return null
  }

  const first = definitions.get(parsed.first)
  const second = definitions.get(parsed.second)
  const lineLabel = first?.name === 'Line' ? parsed.first : second?.name === 'Line' ? parsed.second : null
  const circleLabel =
    first?.name === 'Circle' ? parsed.first : second?.name === 'Circle' ? parsed.second : null

  if (!lineLabel || !circleLabel) {
    return null
  }

  const line = readLinePoints(api, definitions, pointDefinitions, lineLabel)
  const circle = definitions.get(circleLabel)

  if (!line || !circle || circle.args.length < 2) {
    return null
  }

  const center = readPoint(api, circle.args[0], pointDefinitions)
  const radius = readCircleRadius(api, definitions, pointDefinitions, circle)

  if (!center || radius === null) {
    return null
  }

  const intersections = intersectLineCircle(line.start, line.end, center, radius)

  if (intersections.length === 0) {
    return null
  }

  const preferredIndex = parsed.index === 2 && intersections.length > 1 ? 1 : 0
  const point = intersections[preferredIndex]

  return `${parsed.label} = (${formatCoordinate(point.x)}, ${formatCoordinate(point.y)})`
}

function readCircleRadius(
  api: GeoGebraApi,
  definitions: Map<string, ParsedCall>,
  pointDefinitions: Map<string, Point2D>,
  circle: ParsedCall,
) {
  const radiusArg = circle.args[1]
  const numericRadius = Number(radiusArg)

  if (Number.isFinite(numericRadius)) {
    return numericRadius
  }

  const throughPoint = readPoint(api, radiusArg, pointDefinitions)

  if (throughPoint) {
    const center = readPoint(api, circle.args[0], pointDefinitions)
    return center ? distance(center, throughPoint) : null
  }

  const radiusObject = definitions.get(radiusArg)

  if (radiusObject?.name === 'Segment' && radiusObject.args.length >= 2) {
    const start = readPoint(api, radiusObject.args[0], pointDefinitions)
    const end = readPoint(api, radiusObject.args[1], pointDefinitions)
    return start && end ? distance(start, end) : null
  }

  return null
}

function parseIndexedIntersectCommand(command: string) {
  const assignment = parseAssignment(command)
  const call = assignment.lhs ? parseCallExpression(assignment.rhs) : null

  if (!assignment.lhs || call?.name !== 'Intersect' || call.args.length !== 3) {
    return null
  }

  const index = Number(call.args[2])

  if (!Number.isInteger(index)) {
    return null
  }

  return {
    label: assignment.lhs,
    first: call.args[0],
    second: call.args[1],
    index,
  }
}

function rememberCommandDefinition(
  command: string,
  definitions: Map<string, ParsedCall>,
  pointDefinitions: Map<string, Point2D>,
) {
  const assignment = parseAssignment(command)
  const call = assignment.lhs ? parseCallExpression(assignment.rhs) : null
  const point = assignment.lhs ? parsePointLiteral(assignment.rhs) : null

  if (assignment.lhs && point) {
    pointDefinitions.set(assignment.lhs, point)
  }

  if (assignment.lhs && call) {
    definitions.set(assignment.lhs, call)
  }
}

function parseCallExpression(expression: string): ParsedCall | null {
  const trimmed = expression.trim()
  const match = trimmed.match(/^([A-Za-z]\w*)\s*\(/)

  if (!match) {
    return null
  }

  const openIndex = trimmed.indexOf('(')
  const closeIndex = findMatchingParen(trimmed, openIndex)

  if (closeIndex !== trimmed.length - 1) {
    return null
  }

  return {
    name: match[1],
    args: splitTopLevelArgs(trimmed.slice(openIndex + 1, closeIndex)),
  }
}

function findMatchingParen(text: string, openIndex: number) {
  let depth = 0

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]

    if (char === '(') {
      depth += 1
      continue
    }

    if (char === ')') {
      depth -= 1

      if (depth === 0) {
        return index
      }
    }
  }

  return -1
}

function splitTopLevelArgs(args: string) {
  const result: string[] = []
  let current = ''
  let depth = 0

  for (const char of args) {
    if (char === '(') {
      depth += 1
      current += char
      continue
    }

    if (char === ')') {
      depth -= 1
      current += char
      continue
    }

    if (char === ',' && depth === 0) {
      result.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  if (current.trim().length > 0 || args.trim().length === 0) {
    result.push(current.trim())
  }

  return result
}

function parsePointLiteral(expression: string): Point2D | null {
  const match = expression
    .trim()
    .match(/^\(\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*,\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*\)$/i)

  if (!match) {
    return null
  }

  const x = Number(match[1])
  const y = Number(match[2])

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }

  return { x, y }
}

function readPoint(
  api: GeoGebraApi,
  name: string,
  pointDefinitions?: Map<string, Point2D>,
): Point2D | null {
  const rememberedPoint = pointDefinitions?.get(name)

  if (rememberedPoint) {
    return rememberedPoint
  }

  if (typeof api.getXcoord !== 'function' || typeof api.getYcoord !== 'function') {
    return null
  }

  try {
    const x = api.getXcoord(name)
    const y = api.getYcoord(name)

    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y }
    }
  } catch {
    return null
  }

  return null
}

function deleteObject(api: GeoGebraApi, name: string) {
  if (typeof api.deleteObject === 'function') {
    try {
      api.deleteObject(name)
      return
    } catch {
      // Fall back to the GeoGebra command below.
    }
  }

  try {
    api.evalCommand(`Delete(${name})`)
  } catch {
    // Best effort cleanup only.
  }
}

function clearExistingObjects(api: GeoGebraApi) {
  if (typeof api.getAllObjectNames !== 'function') {
    return
  }

  try {
    const names = api.getAllObjectNames()

    for (const name of [...names].reverse()) {
      if (typeof name === 'string') {
        deleteObject(api, name)
      }
    }
  } catch {
    // Clearing is best effort; command execution will report concrete failures.
  }
}

function readLinePoints(
  api: GeoGebraApi,
  definitions: Map<string, ParsedCall>,
  pointDefinitions: Map<string, Point2D>,
  label: string,
) {
  const definition = definitions.get(label)

  if (definition?.name === 'Line' && definition.args.length >= 2) {
    const start = readPoint(api, definition.args[0], pointDefinitions)
    const end = readPoint(api, definition.args[1], pointDefinitions)

    if (start && end) {
      return { start, end }
    }
  }

  const inferredPair = inferLinePointNames(label)

  if (!inferredPair) {
    return null
  }

  const start = readPoint(api, inferredPair[0], pointDefinitions)
  const end = readPoint(api, inferredPair[1], pointDefinitions)

  if (!start || !end) {
    return null
  }

  return { start, end }
}

function inferLinePointNames(label: string): [string, string] | null {
  const compactLabel = label.replace(/^aux/i, '').replace(/_?line$/i, '')

  if (/^[A-Z][A-Z]$/.test(compactLabel)) {
    return [compactLabel[0], compactLabel[1]]
  }

  return null
}

function intersectLineCircle(lineStart: Point2D, lineEnd: Point2D, center: Point2D, radius: number) {
  const dx = lineEnd.x - lineStart.x
  const dy = lineEnd.y - lineStart.y
  const fx = lineStart.x - center.x
  const fy = lineStart.y - center.y
  const a = dx * dx + dy * dy
  const b = 2 * (fx * dx + fy * dy)
  const c = fx * fx + fy * fy - radius * radius
  const discriminant = b * b - 4 * a * c

  if (a === 0 || discriminant < -1e-9) {
    return []
  }

  if (Math.abs(discriminant) <= 1e-9) {
    const t = -b / (2 * a)
    return [{ x: lineStart.x + t * dx, y: lineStart.y + t * dy }]
  }

  const root = Math.sqrt(discriminant)
  const t1 = (-b - root) / (2 * a)
  const t2 = (-b + root) / (2 * a)

  return [
    { x: lineStart.x + t1 * dx, y: lineStart.y + t1 * dy },
    { x: lineStart.x + t2 * dx, y: lineStart.y + t2 * dy },
  ]
}

function intersectLines(
  firstStart: Point2D,
  firstEnd: Point2D,
  secondStart: Point2D,
  secondEnd: Point2D,
) {
  const x1 = firstStart.x
  const y1 = firstStart.y
  const x2 = firstEnd.x
  const y2 = firstEnd.y
  const x3 = secondStart.x
  const y3 = secondStart.y
  const x4 = secondEnd.x
  const y4 = secondEnd.y
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)

  if (Math.abs(denominator) <= 1e-9) {
    return null
  }

  const firstDeterminant = x1 * y2 - y1 * x2
  const secondDeterminant = x3 * y4 - y3 * x4

  return {
    x: (firstDeterminant * (x3 - x4) - (x1 - x2) * secondDeterminant) / denominator,
    y: (firstDeterminant * (y3 - y4) - (y1 - y2) * secondDeterminant) / denominator,
  }
}

function distance(a: Point2D, b: Point2D) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function formatCoordinate(value: number) {
  return Number(value.toPrecision(12)).toString()
}

function validateCommandDependencies(commands: string[]) {
  const definedNames = new Set<string>()
  const failures: CommandExecutionFailure[] = []

  for (const [index, command] of commands.entries()) {
    const trimmedCommand = command.trim()
    const assignment = parseAssignment(trimmedCommand)
    const nestedCommands = extractNestedCommandNames(assignment.rhs)
    const referencedNames = extractReferencedNames(assignment.rhs)
    const missingNames = referencedNames.filter((name) => !definedNames.has(name))

    if (nestedCommands.length > 0 || missingNames.length > 0) {
      const messages: string[] = []

      if (nestedCommands.length > 0) {
        messages.push(`Comando aninhado não permitido: ${nestedCommands.join(', ')}`)
      }

      if (missingNames.length > 0) {
        messages.push(`Nome indefinido: ${missingNames.join(', ')}`)
      }

      failures.push({
        kind: 'validation',
        line: index + 1,
        command,
        missingNames,
        nestedCommands,
        message: messages.join(' | '),
      })
      continue
    }

    if (assignment.lhs) {
      definedNames.add(assignment.lhs)
    }
  }

  return failures
}

function parseAssignment(command: string) {
  const match = command.match(/^\s*([A-Za-z]\w*)\s*=\s*(.+)$/)

  if (!match) {
    return { lhs: null, rhs: command }
  }

  return { lhs: match[1], rhs: match[2] }
}

function extractNestedCommandNames(expression: string) {
  const commandNames: string[] = []
  const commandPattern = /\b([A-Za-z]\w*)\s*\(/g
  let isRootCommand = true

  for (const match of expression.matchAll(commandPattern)) {
    const commandName = match[1]

    if (isRootCommand && match.index === expression.search(/\S/)) {
      isRootCommand = false
      continue
    }

    if (GEOGEBRA_COMMAND_NAMES.has(commandName)) {
      commandNames.push(commandName)
    }
  }

  return Array.from(new Set(commandNames))
}

function extractReferencedNames(expression: string) {
  const withoutStrings = expression.replace(/"[^"]*"/g, '')
  const names = new Set<string>()
  const identifierPattern = /\b[A-Za-z]\w*\b/g

  for (const match of withoutStrings.matchAll(identifierPattern)) {
    const identifier = match[0]

    if (!GEOGEBRA_COMMAND_NAMES.has(identifier) && !GEOGEBRA_RESERVED_IDENTIFIERS.has(identifier)) {
      names.add(identifier)
    }
  }

  return Array.from(names)
}

function mergeCollinearSegmentsInApplet(api: GeoGebraApi, commands: string[]) {
  const coords = readPointCoordinates(api)
  const existingNames = readObjectNames(api)
  const plan = planCollinearSegmentMerge(commands, coords, existingNames)
  const warnings = [...plan.warnings]

  for (const action of plan.actions) {
    for (const name of action.hideNames) {
      try {
        api.setVisible?.(name, false)
      } catch (error) {
        warnings.push(`Failed to hide redundant segment ${name}: ${formatError(error)}`)
      }
    }

    if (!action.createCommand) {
      continue
    }

    try {
      const ok = api.evalCommand(action.createCommand)

      if (!ok) {
        warnings.push(`GeoGebra rejected merged segment: ${action.createCommand}`)
      }
    } catch (error) {
      warnings.push(`Failed to create merged segment ${action.createCommand}: ${formatError(error)}`)
    }
  }

  return warnings
}

function readPointCoordinates(api: GeoGebraApi) {
  const coords: CoordMap = {}

  if (
    typeof api.getAllObjectNames !== 'function' ||
    typeof api.getXcoord !== 'function' ||
    typeof api.getYcoord !== 'function'
  ) {
    return coords
  }

  const names = safeGetObjectNames(api, 'point')

  for (const name of names) {
    try {
      const x = api.getXcoord(name)
      const y = api.getYcoord(name)

      if (Number.isFinite(x) && Number.isFinite(y)) {
        coords[name] = { x, y }
      }
    } catch {
      // Non-point objects may throw in some GeoGebra builds.
    }
  }

  return coords
}

function readObjectNames(api: GeoGebraApi) {
  return new Set(safeGetObjectNames(api))
}

function safeGetObjectNames(api: GeoGebraApi, objectType?: string) {
  if (typeof api.getAllObjectNames !== 'function') {
    return []
  }

  try {
    return api.getAllObjectNames(objectType)
  } catch {
    return []
  }
}

function hideAuxiliaryObjects(api: GeoGebraApi | null) {
  if (!api || typeof api.getAllObjectNames !== 'function') {
    return
  }

  try {
    const names = api.getAllObjectNames()

    for (const name of names) {
      if (typeof name === 'string' && name.startsWith('aux')) {
        api.setVisible?.(name, false)
      }
    }
  } catch (error) {
    console.warn('Failed to hide auxiliary GeoGebra objects:', error)
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error'
}

function loadGeoGebraScript() {
  if (window.GGBApplet) {
    return Promise.resolve()
  }

  if (scriptPromise) {
    return scriptPromise
  }

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-geogebra]')

    if (existing) {
      if (window.GGBApplet) {
        resolve()
        return
      }

      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('GeoGebra script failed')), {
        once: true,
      })
      return
    }

    const script = document.createElement('script')
    script.src = DEPLOY_GGB_URL
    script.async = true
    script.dataset.geogebra = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('GeoGebra script failed'))
    document.head.appendChild(script)
  })

  return scriptPromise
}
