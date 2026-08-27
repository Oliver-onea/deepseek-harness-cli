import type { Palette } from './theme.ts'

/**
 * Apply syntax highlighting to code blocks based on language.
 * @param code - the raw code string.
 * @param lang - the language identifier.
 * @param palette - the component palette.
 * @returns the lines with injected SGR styling, or `undefined` to fallback.
 */

export function highlightCode(code: string, lang: string | undefined, palette: Palette): string[] {
  if (!lang) return code.split('\n').map(line => palette.code(line))
  const l = lang.toLowerCase()

  if (l === 'diff') {
    return code.split('\n').map((line) => {
      if (line.startsWith('+')) return palette.success(line)
      if (line.startsWith('-')) return palette.error(line)
      if (line.startsWith('@')) return palette.dim(line)
      return palette.code(line)
    })
  }

  let highlighted = code
  let supported = false

  if (l === 'json') {
    supported = true
    highlighted = highlighted.replace(/(".*?")/g, palette.codeString('$1'))
    highlighted = highlighted.replace(/\b(true|false|null|\d+(?:\.\d+)?)\b/g, palette.codeKeyword('$1'))
  } else if (l === 'ts' || l === 'typescript' || l === 'js' || l === 'javascript') {
    supported = true
    const words = 'const|let|var|function|class|import|export|if|else|return|async|await|for|while|true|false|null|undefined|switch|case|break|continue|yield|type|interface|from'
    const kw = new RegExp(`\\b(${words})\\b`, 'g')
    highlighted = highlighted.replace(kw, palette.codeKeyword('$1'))
    highlighted = highlighted.replace(/(["'`].*?["'`])/g, palette.codeString('$1'))
    highlighted = highlighted.replace(/(\/\/.*$)/gm, palette.codeComment('$1'))
  } else if (l === 'sh' || l === 'bash' || l === 'shell') {
    supported = true
    highlighted = highlighted.replace(/(["'].*?["'])/g, palette.codeString('$1'))
    highlighted = highlighted.replace(/(^|\s)(sudo|npm|pnpm|yarn|git|node|tsx|dsh)(\s|$)/gm, `$1${palette.codeKeyword('$2')}$3`)
    highlighted = highlighted.replace(/(\s-[a-zA-Z0-9-]*)/g, palette.dim('$1'))
    highlighted = highlighted.replace(/(#.*$)/gm, palette.codeComment('$1'))
  } else if (l === 'md' || l === 'markdown') {
    supported = true
    highlighted = highlighted.replace(/^(#+.*$)/gm, palette.heading('$1'))
    highlighted = highlighted.replace(/(`.*?`)/g, palette.codeString('$1'))
  }

  if (!supported) return code.split('\n').map(line => palette.code(line))

  // Return highlighted text as-is, which means the unstyled parts are terminal default color.
  // This is what we wanted for syntax-highlighted blocks.
  return highlighted.split('\n')
}
