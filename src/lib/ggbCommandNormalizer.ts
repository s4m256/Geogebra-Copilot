export interface NormalizeResult {
  ok: boolean
  commands: string[]
  errors: string[]
  warnings: string[]
}

type Assignment = {
  label: string | null
  expression: string
}

type ParsedCall = {
  name: string
  args: string[]
}

type NormalizerContext = {
  usedLabels: Set<string>
  definitions: Map<string, ParsedCall>
  auxCounters: Map<string, number>
  errors: string[]
  warnings: string[]
}

const SUPPORTED_COMMANDS = new Set([
  'Line',
  'Segment',
  'Ray',
  'Circle',
  'Midpoint',
  'PerpendicularLine',
  'ParallelLine',
  'Intersect',
  'Polygon',
  'Angle',
  'AngleBisector',
  'Distance',
  'Vector',
  'Reflect',
  'Translate',
  'Rotate',
])

const COMMENT_PREFIXES = ['//', '#']

export function normalizeGeoGebraBlock(code: string): NormalizeResult {
  const errors: string[] = []
  const warnings: string[] = []
  const lines = code
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trim(), lineNumber: index + 1 }))
    .filter(({ text }) => text.length > 0)
    .filter(({ text }) => !COMMENT_PREFIXES.some((prefix) => text.startsWith(prefix)))
    .filter(({ text }) => !text.includes('```'))

  const usedLabels = new Set<string>()

  for (const { text } of lines) {
    const assignment = parseAssignment(text)

    if (assignment?.label) {
      usedLabels.add(assignment.label)
    }
  }

  const context: NormalizerContext = {
    usedLabels,
    definitions: new Map(),
    auxCounters: new Map(),
    errors,
    warnings,
  }
  const commands: string[] = []

  for (const { text, lineNumber } of lines) {
    if (hasInlineComment(text)) {
      errors.push(`Linha ${lineNumber}: comentarios inline nao sao permitidos em comandos GeoGebra.`)
      continue
    }

    const assignment = parseAssignment(text)

    if (!assignment) {
      errors.push(`Linha ${lineNumber}: comando sem atribuicao nao suportado pelo normalizador: ${text}`)
      continue
    }

    const normalized = normalizeExpression(assignment.expression, context, lineNumber, false)

    if (!normalized) {
      continue
    }

    for (const command of normalized.hoisted) {
      commands.push(command)
      rememberDefinition(command, context)
    }

    const command = `${assignment.label} = ${normalized.expression}`
    commands.push(command)
    rememberDefinition(command, context)
  }

  if (commands.some((command) => commandContainsNestedCall(command))) {
    errors.push('O normalizador gerou comando aninhado. A execucao foi bloqueada por seguranca.')
  }

  if (commands.length > 0 && commands.join('\n') !== cleanedInput(lines)) {
    warnings.push('Commands normalized before execution.')
  }

  return {
    ok: errors.length === 0,
    commands,
    errors,
    warnings,
  }
}

function parseAssignment(line: string): Assignment | null {
  const equalsIndex = line.indexOf('=')

  if (equalsIndex < 0) {
    return null
  }

  const label = line.slice(0, equalsIndex).trim()
  const expression = line.slice(equalsIndex + 1).trim()

  if (!/^[A-Za-z]\w*$/.test(label) || expression.length === 0) {
    return null
  }

  return { label, expression }
}

function normalizeExpression(
  expression: string,
  context: NormalizerContext,
  lineNumber: number,
  shouldHoist: boolean,
): { expression: string; hoisted: string[] } | null {
  const call = parseCallExpression(expression)

  if (!call) {
    if (containsCommandLikeCall(expression)) {
      context.errors.push(
        `Linha ${lineNumber}: chamada de comando em expressao complexa nao suportada: ${expression}`,
      )
      return null
    }

    return { expression, hoisted: [] }
  }

  const commandError = validateCommandName(call.name, lineNumber)

  if (commandError) {
    context.errors.push(commandError)
    return null
  }

  const hoisted: string[] = []
  const args: string[] = []

  for (const arg of call.args) {
    const nestedCall = parseCallExpression(arg)

    if (nestedCall) {
      const normalized = normalizeExpression(arg, context, lineNumber, true)

      if (!normalized) {
        return null
      }

      for (const command of normalized.hoisted) {
        hoisted.push(command)
        rememberDefinition(command, context)
      }

      hoisted.push(normalized.expression)
      rememberDefinition(normalized.expression, context)
      args.push(readAssignmentLabel(normalized.expression))
      continue
    }

    if (containsCommandLikeCall(arg)) {
      context.errors.push(
        `Linha ${lineNumber}: comando aninhado em argumento complexo nao pode ser normalizado com seguranca: ${arg}`,
      )
      return null
    }

    args.push(arg)
  }

  const normalizedExpression = `${call.name}(${normalizeArgs(call.name, args, context).join(', ')})`

  if (!shouldHoist) {
    return { expression: normalizedExpression, hoisted }
  }

  const auxLabel = nextAuxLabel(context, call.name)
  return {
    expression: `${auxLabel} = ${normalizedExpression}`,
    hoisted,
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

  const rawArgs = trimmed.slice(openIndex + 1, closeIndex)
  return {
    name: match[1],
    args: splitTopLevelArgs(rawArgs),
  }
}

function findMatchingParen(text: string, openIndex: number) {
  let depth = 0
  let quote: string | null = null

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]

    if (quote) {
      if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

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
  let quote: string | null = null

  for (const char of args) {
    if (quote) {
      current += char

      if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

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

function validateCommandName(name: string, lineNumber: number) {
  if (name === 'Foot') {
    return `Linha ${lineNumber}: Foot nao e um comando permitido. Para pes de altura, use Line + PerpendicularLine + Intersect.`
  }

  if (!SUPPORTED_COMMANDS.has(name)) {
    return `Linha ${lineNumber}: comando GeoGebra nao suportado pelo normalizador: ${name}.`
  }

  return null
}

function normalizeArgs(commandName: string, args: string[], context: NormalizerContext) {
  if (
    commandName === 'Intersect' &&
    args.length === 3 &&
    isCircleLabel(args[0]) &&
    isAuxiliaryLabel(args[1])
  ) {
    return [args[1], args[0], args[2]]
  }

  if (commandName === 'Midpoint' && args.length === 1) {
    const source = context.definitions.get(args[0].trim())

    if (source && (source.name === 'Line' || source.name === 'Segment') && source.args.length >= 2) {
      return [source.args[0], source.args[1]]
    }
  }

  return args
}

function rememberDefinition(command: string, context: NormalizerContext) {
  const assignment = parseAssignment(command)

  if (!assignment?.label) {
    return
  }

  const call = parseCallExpression(assignment.expression)

  if (call) {
    context.definitions.set(assignment.label, call)
  }
}

function isCircleLabel(value: string) {
  return /^c[A-Za-z0-9_]*$/.test(value.trim())
}

function isAuxiliaryLabel(value: string) {
  return /^aux[A-Za-z0-9_]*$/.test(value.trim())
}

function containsCommandLikeCall(expression: string) {
  return /\b[A-Za-z]\w*\s*\(/.test(expression)
}

function commandContainsNestedCall(command: string) {
  const assignment = parseAssignment(command)
  const expression = assignment?.expression ?? command
  const outer = parseCallExpression(expression)

  if (!outer) {
    return false
  }

  return outer.args.some((arg) => containsCommandLikeCall(arg))
}

function readAssignmentLabel(command: string) {
  const assignment = parseAssignment(command)

  if (!assignment?.label) {
    throw new Error(`Internal normalizer error: missing generated label for ${command}`)
  }

  return assignment.label
}

function nextAuxLabel(context: NormalizerContext, commandName: string) {
  let next = (context.auxCounters.get(commandName) ?? 0) + 1
  let label = `aux${commandName}${next}`

  while (context.usedLabels.has(label)) {
    next += 1
    label = `aux${commandName}${next}`
  }

  context.auxCounters.set(commandName, next)
  context.usedLabels.add(label)
  return label
}

function hasInlineComment(line: string) {
  return line.includes('//') || line.includes('#')
}

function cleanedInput(lines: Array<{ text: string }>) {
  return lines.map(({ text }) => text).join('\n')
}
