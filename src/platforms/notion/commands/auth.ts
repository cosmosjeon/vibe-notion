import { Command } from 'commander'

import { BrowserTokenExtractor } from '@/platforms/notion/browser-token-extractor'
import { CredentialManager } from '@/platforms/notion/credential-manager'
import {
  maskAccount,
  maskToken,
  TokenValidationError,
  validateCandidates,
  validateTokenV2,
  withStoredAccounts,
  type ExtractionOutcome,
} from '@/platforms/notion/extracted-token-validation'
import { type ExtractedToken, TokenExtractor } from '@/platforms/notion/token-extractor'
import { handleNotionError } from '@/shared/utils/error-handler'
import { formatOutput } from '@/shared/utils/output'

type CommandOptions = { pretty?: boolean; debug?: boolean; source?: 'auto' | 'app' | 'browser' }

function parseSource(source: string | undefined): 'auto' | 'app' | 'browser' {
  if (!source) return 'auto'
  if (source === 'auto') return 'auto'
  if (source === 'app') return 'app'
  if (source === 'browser') return 'browser'

  throw new Error(`Invalid source: ${source}. Expected "auto", "app", or "browser".`)
}

function shouldFallbackToBrowser(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('Notion directory not found')
}

async function collectCandidatesFromApp(options: CommandOptions): Promise<{ candidates: ExtractedToken[]; errors: string[] }> {
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

  const candidates = await ('extractAll' in extractor && typeof extractor.extractAll === 'function'
    ? await extractor.extractAll()
    : extractor.extract().then((extracted) => (extracted ? [extracted] : [])))

  return { candidates, errors: extractor.getErrors() }
}

async function collectCandidatesFromBrowser(options: CommandOptions): Promise<{ candidates: ExtractedToken[]; errors: string[] }> {
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

  const candidates = 'extractAll' in extractor && typeof extractor.extractAll === 'function'
    ? await extractor.extractAll()
    : await extractor.extract()
  const extractedCandidates = Array.isArray(candidates)
    ? candidates
    : candidates
      ? [candidates]
      : []

  return { candidates: extractedCandidates, errors: extractor.getErrors() }
}

async function extractFromApp(options: CommandOptions): Promise<ExtractionOutcome> {
  const { candidates, errors } = await collectCandidatesFromApp(options)
  const validation = await validateCandidates(candidates, 'app')
  return { ...validation, errors: [...errors, ...validation.errors] }
}

async function extractFromBrowser(options: CommandOptions): Promise<ExtractionOutcome> {
  const { candidates, errors } = await collectCandidatesFromBrowser(options)
  const validation = await validateCandidates(candidates, 'browser')
  return { ...validation, errors: [...errors, ...validation.errors] }
}

async function extractAutomatically(options: CommandOptions): Promise<ExtractionOutcome> {
  let appErrors: string[] = []

  try {
    const result = await extractFromApp(options)
    appErrors = result.errors
    if (result.extracted) {
      return result
    }
  } catch (error) {
    if (!shouldFallbackToBrowser(error)) {
      throw error
    }

    const message = error instanceof Error ? error.message : String(error)
    appErrors = [
      message,
      ...appErrors,
    ]
  }

  const browserResult = await extractFromBrowser(options)
  return {
    ...browserResult,
    errors: [...appErrors, ...browserResult.errors],
  }
}

async function extractAction(options: CommandOptions): Promise<void> {
  try {
    const source = parseSource(options.source)
    const result = source === 'browser'
      ? await extractFromBrowser(options)
      : source === 'app'
        ? await extractFromApp(options)
        : await extractAutomatically(options)
    const { extracted, errors, accounts } = result

    if (options.debug) {
      for (const err of errors) {
        console.error(`[debug] ${err}`)
      }
    }

    if (!extracted) {
      const errorMessage = result.source === 'browser'
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

    const manager = new CredentialManager()
    await manager.setCredentials(withStoredAccounts(extracted, accounts))

    console.log(
      formatOutput(
        {
          source: result.source,
          token_v2: maskToken(extracted.token_v2),
          user_id: extracted.user_id,
          user_ids: extracted.user_ids,
          accounts: accounts.map(maskAccount),
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
      .option('--source <source>', 'Extraction source: auto (default), app, or browser', 'auto')
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
