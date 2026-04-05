import { Command } from 'commander'

import { BrowserTokenExtractor } from '@/platforms/notion/browser-token-extractor'
import { CredentialManager } from '@/platforms/notion/credential-manager'
import { type ExtractedToken, TokenExtractor } from '@/platforms/notion/token-extractor'
import { handleNotionError } from '@/shared/utils/error-handler'
import { formatOutput } from '@/shared/utils/output'

type CommandOptions = { pretty?: boolean; debug?: boolean; source?: 'app' | 'browser' }

function parseSource(source: string | undefined): 'app' | 'browser' {
  if (!source) return 'app'
  if (source === 'app') return 'app'
  if (source === 'browser') return 'browser'

  throw new Error(`Invalid source: ${source}. Expected "app" or "browser".`)
}

function maskToken(token: string): string {
  if (token.length <= 10) {
    return '***'
  }
  return `${token.slice(0, 6)}...${token.slice(-4)}`
}

class TokenValidationError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function validateTokenV2(tokenV2: string): Promise<void> {
  const response = await fetch('https://www.notion.so/api/v3/getSpaces', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `token_v2=${tokenV2}`,
    },
    body: '{}',
  })

  if (!response.ok) {
    throw new TokenValidationError(response.status, `Notion internal API error: ${response.status}`)
  }
}

async function extractFromApp(options: CommandOptions): Promise<{ extracted: ExtractedToken | null; errors: string[] }> {
  const extractor = new TokenExtractor(undefined, undefined, { debug: options.debug })

  if (process.platform === 'darwin') {
    console.log('')
    console.log('  Extracting your Notion credentials...')
    console.log('')
    console.log('  Your Mac may ask for your password to access Keychain.')
    console.log('  This is required because Notion encrypts your login cookies')
    console.log('  using macOS Keychain for security.')
    console.log('')
    console.log('  What happens:')
    console.log("    1. We read the encrypted cookie from Notion's local storage")
    console.log('    2. macOS Keychain decrypts it (requires your password)')
    console.log('    3. The token is stored locally in ~/.config/vibe-notion/')
    console.log('')
    console.log('  Your password is never stored or transmitted anywhere.')
    console.log('')
  }

  if (options.debug) {
    console.error(`[debug] Notion directory: ${extractor.getNotionDir()}`)
  }

  const extracted = await extractor.extract()
  return { extracted, errors: extractor.getErrors() }
}

async function extractFromBrowser(options: CommandOptions): Promise<{ extracted: ExtractedToken | null; errors: string[] }> {
  const extractor = new BrowserTokenExtractor(undefined, { debug: options.debug })

  if (process.platform === 'darwin') {
    console.log('')
    console.log('  Extracting your Notion credentials from browser...')
    console.log('')
    console.log('  Your Mac may ask for your password to access Keychain.')
    console.log('  This is required because browsers encrypt cookies')
    console.log('  using macOS Keychain for security.')
    console.log('')
    console.log('  Your password is never stored or transmitted anywhere.')
    console.log('')
  }

  const extracted = await extractor.extract()
  return { extracted, errors: extractor.getErrors() }
}

async function extractAction(options: CommandOptions): Promise<void> {
  try {
    const source = parseSource(options.source)
    const { extracted, errors } = source === 'browser'
      ? await extractFromBrowser(options)
      : await extractFromApp(options)

    if (options.debug) {
      for (const err of errors) {
        console.error(`[debug] ${err}`)
      }
    }

    if (!extracted) {
      const errorMessage = source === 'browser'
        ? 'No token_v2 found in any browser. Make sure you are logged in to Notion in a Chromium-based browser.'
        : 'No token_v2 found. Make sure Notion desktop app is installed and logged in.'

      console.log(
        formatOutput(
          {
            error: errorMessage,
            hint: options.debug ? undefined : 'Run with --debug for more info.',
            ...(options.debug && errors.length > 0 ? { extraction_errors: errors } : {}),
          },
          options.pretty,
        ),
      )
      process.exit(1)
    }

    if (options.debug) {
      console.error(`[debug] token_v2 extracted: ${maskToken(extracted.token_v2)}`)
    }

    await validateTokenV2(extracted.token_v2)

    const manager = new CredentialManager()
    await manager.setCredentials(extracted)

    console.log(
      formatOutput(
        {
          source,
          token_v2: maskToken(extracted.token_v2),
          user_id: extracted.user_id,
          user_ids: extracted.user_ids,
          valid: true,
        },
        options.pretty,
      ),
    )
  } catch (error) {
    handleNotionError(error)
  }
}

async function logoutAction(options: CommandOptions): Promise<void> {
  try {
    const manager = new CredentialManager()
    await manager.remove()
    console.log(formatOutput({ success: true }, options.pretty))
  } catch (error) {
    handleNotionError(error)
  }
}

async function statusAction(options: CommandOptions): Promise<void> {
  try {
    const manager = new CredentialManager()
    const stored = await manager.getCredentials()

    if (!stored) {
      console.log(formatOutput({ authenticated: false, stored_token_v2: null }, options.pretty))
      return
    }

    let valid = false
    try {
      await validateTokenV2(stored.token_v2)
      valid = true
    } catch (error) {
      if (error instanceof TokenValidationError && (error.status === 401 || error.status === 403)) {
        valid = false
      } else {
        throw error
      }
    }

    console.log(
      formatOutput(
        {
          authenticated: valid,
          stored_token_v2: {
            token_v2: maskToken(stored.token_v2),
            user_id: stored.user_id,
          },
          ...(valid ? {} : { hint: 'Token is stale or revoked. Run: vibe-notion auth extract' }),
        },
        options.pretty,
      ),
    )
  } catch (error) {
    handleNotionError(error)
  }
}

export const authCommand = new Command('auth')
  .description('Authentication commands')
  .addCommand(
    new Command('extract')
      .description('Extract token_v2 from Notion desktop app or browser')
      .option('--pretty', 'Pretty print JSON output')
      .option('--debug', 'Show debug output for troubleshooting')
      .option('--source <source>', 'Extraction source: app (default) or browser', 'app')
      .action(extractAction),
  )
  .addCommand(
    new Command('logout')
      .description('Remove locally stored token_v2 credentials')
      .option('--pretty', 'Pretty print JSON output')
      .action(logoutAction),
  )
  .addCommand(
    new Command('status')
      .description('Show stored credential status')
      .option('--pretty', 'Pretty print JSON output')
      .action(statusAction),
  )
