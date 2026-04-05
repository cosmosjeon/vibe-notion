import { execSync } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExtractedToken } from '@/platforms/notion/token-extractor'

const require = createRequire(import.meta.url)

interface BrowserConfig {
  name: string
  darwin: string
  linux: string
  win32: string
}

interface KeychainVariant {
  service: string
  account: string
}

type CookieRow = {
  name: string
  value?: string
  encrypted_value?: Uint8Array | Buffer
  last_access_utc?: number
}

type BetterSqlite3Database = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  close(): void
}

type BetterSqlite3Constructor = {
  new (path: string, options?: Record<string, unknown>): BetterSqlite3Database
}

const BROWSERS: BrowserConfig[] = [
  {
    name: 'Chrome',
    darwin: join('Google', 'Chrome'),
    linux: 'google-chrome',
    win32: join('Google', 'Chrome', 'User Data'),
  },
  {
    name: 'Chrome Canary',
    darwin: join('Google', 'Chrome Canary'),
    linux: 'google-chrome-unstable',
    win32: join('Google', 'Chrome SxS', 'User Data'),
  },
  {
    name: 'Edge',
    darwin: 'Microsoft Edge',
    linux: 'microsoft-edge',
    win32: join('Microsoft', 'Edge', 'User Data'),
  },
  {
    name: 'Arc',
    darwin: join('Arc', 'User Data'),
    linux: '',
    win32: join('Arc', 'User Data'),
  },
  {
    name: 'Brave',
    darwin: join('BraveSoftware', 'Brave-Browser'),
    linux: join('BraveSoftware', 'Brave-Browser'),
    win32: join('BraveSoftware', 'Brave-Browser', 'User Data'),
  },
  {
    name: 'Vivaldi',
    darwin: 'Vivaldi',
    linux: 'vivaldi',
    win32: join('Vivaldi', 'User Data'),
  },
  {
    name: 'Chromium',
    darwin: 'Chromium',
    linux: 'chromium',
    win32: join('Chromium', 'User Data'),
  },
]

const NOTION_HOST_KEYS = ['.notion.so', 'www.notion.so', 'notion.so']
const NOTION_COOKIE_NAMES = ['token_v2', 'notion_user_id', 'notion_users']

const KEYCHAIN_VARIANTS: KeychainVariant[] = [
  { service: 'Chrome Safe Storage', account: 'Chrome' },
  { service: 'Chrome Canary Safe Storage', account: 'Chrome Canary' },
  { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
  { service: 'Arc Safe Storage', account: 'Arc' },
  { service: 'Brave Safe Storage', account: 'Brave' },
  { service: 'Vivaldi Safe Storage', account: 'Vivaldi' },
  { service: 'Chromium Safe Storage', account: 'Chromium' },
]

const LINUX_KEYRING_APP_NAMES = [
  'Chrome',
  'chrome',
  'google-chrome',
  'Chrome Canary',
  'chrome canary',
  'google-chrome-unstable',
  'Microsoft Edge',
  'microsoft-edge',
  'Brave',
  'brave',
  'Brave Browser',
  'Vivaldi',
  'vivaldi',
  'Chromium',
  'chromium',
]

const TOKEN_REGEX = /v\d+(%3A|:)[A-Za-z0-9_.%-]+/
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

function extractValueFromDecrypted(decrypted: string): string {
  const tokenMatch = decrypted.match(TOKEN_REGEX)
  if (tokenMatch) return tokenMatch[0]

  const uuidMatch = decrypted.match(UUID_REGEX)
  if (uuidMatch) return uuidMatch[0]

  return decrypted
}

export class BrowserTokenExtractor {
  private platform: NodeJS.Platform
  private debug: boolean
  private cachedKey: Buffer | null = null
  private extractionErrors: string[] = []

  constructor(platform?: NodeJS.Platform, options?: { debug?: boolean }) {
    this.platform = platform ?? process.platform
    this.debug = options?.debug ?? false
  }

  getErrors(): string[] {
    return [...this.extractionErrors]
  }

  async extract(): Promise<ExtractedToken | null> {
    const cookiePaths = this.getBrowserCookiePaths()

    for (const cookiePath of cookiePaths) {
      if (!existsSync(cookiePath)) continue

      if (this.debug) {
        console.error(`[debug] Browser cookie path: ${cookiePath}`)
      }

      const extracted = this.copyAndExtract(cookiePath)
      if (extracted) {
        if (this.debug) {
          console.error(`[debug] Found Notion token in: ${cookiePath}`)
        }
        return extracted
      }
    }

    if (this.debug) {
      console.error('[debug] No Notion cookies found in any browser profile')
    }

    return null
  }

  getBrowserCookiePaths(): string[] {
    const paths: string[] = []

    for (const browser of BROWSERS) {
      const browserBase = this.getBrowserBasePath(browser)
      if (!browserBase) continue

      const profileDirs = this.discoverProfileDirs(browserBase)
      for (const profileDir of profileDirs) {
        paths.push(join(profileDir, 'Network', 'Cookies'))
        paths.push(join(profileDir, 'Cookies'))
      }
    }

    return paths
  }

  getBrowserBasePath(browser: BrowserConfig): string | null {
    let relative: string

    switch (this.platform) {
      case 'darwin':
        relative = browser.darwin
        if (!relative) return null
        return join(homedir(), 'Library', 'Application Support', relative)
      case 'linux':
        relative = browser.linux
        if (!relative) return null
        return join(homedir(), '.config', relative)
      case 'win32':
        relative = browser.win32
        if (!relative) return null
        return join(
          process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
          relative,
        )
      default:
        return null
    }
  }

  private discoverProfileDirs(browserBase: string): string[] {
    const dirs: string[] = []

    dirs.push(join(browserBase, 'Default'))

    if (!existsSync(browserBase)) return dirs

    try {
      const entries = readdirSync(browserBase, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!/^Profile \d+$/i.test(entry.name)) continue
        dirs.push(join(browserBase, entry.name))
      }
    } catch {}


    return dirs
  }

  private copyAndExtract(dbPath: string): ExtractedToken | null {
    const tempPath = join(tmpdir(), `notion-browser-cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)

    try {
      copyFileSync(dbPath, tempPath)
    } catch {
      this.extractionErrors.push(`copyAndExtract: failed to copy ${dbPath}`)
      return null
    }

    try {
      return this.readTokenFromDb(tempPath, dbPath)
    } finally {
      try {
        rmSync(tempPath, { force: true })
      } catch {}
    }
  }

  private readTokenFromDb(dbPath: string, originalPath: string): ExtractedToken | null {
    try {
      const placeholders = NOTION_HOST_KEYS.map(() => '?').join(', ')
      const sql = `
        SELECT name, value, encrypted_value, last_access_utc
        FROM cookies
        WHERE host_key IN (${placeholders})
        AND name IN (${NOTION_COOKIE_NAMES.map(() => '?').join(', ')})
        ORDER BY last_access_utc DESC
      `
      const params = [...NOTION_HOST_KEYS, ...NOTION_COOKIE_NAMES]

      let rows: CookieRow[]
      if (typeof globalThis.Bun !== 'undefined') {
        const { Database } = require('bun:sqlite')
        const db = new Database(dbPath, { readonly: true })
        rows = db.query(sql).all(...params) as CookieRow[]
        db.close()
      } else {
        let Database: BetterSqlite3Constructor
        try {
          Database = require('better-sqlite3')
        } catch {
          throw new Error('better-sqlite3 is required for Node.js. Install it with: npm install better-sqlite3')
        }
        const db = new Database(dbPath, { readonly: true })
        rows = db.prepare(sql).all(...params) as CookieRow[]
        db.close()
      }

      rows.sort((a, b) => (b.last_access_utc ?? 0) - (a.last_access_utc ?? 0))

      const cookieMap: Record<string, string> = {}
      for (const row of rows) {
        let value = ''

        if (row.encrypted_value && row.encrypted_value.length > 0) {
          const encBuf = Buffer.from(row.encrypted_value)
          if (this.isEncryptedValue(encBuf)) {
            const decrypted = this.decryptCookie(encBuf, originalPath)
            if (decrypted) {
              value = decrypted
            }
          } else {
            value = encBuf.toString('utf8')
          }
        } else if (row.value) {
          value = row.value
        }

        if (value && !cookieMap[row.name]) {
          cookieMap[row.name] = value
        }
      }

      const rawToken = cookieMap['token_v2']
      if (!rawToken) return null

      const token = extractValueFromDecrypted(rawToken)
      const rawUserId = cookieMap['notion_user_id']
      const userId = rawUserId ? extractValueFromDecrypted(rawUserId) : undefined
      const userIds = this.parseUserIds(cookieMap['notion_users'])

      return {
        token_v2: token,
        ...(userId ? { user_id: userId } : {}),
        ...(userIds.length > 0 ? { user_ids: userIds } : {}),
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('better-sqlite3')) {
        throw error
      }
      this.extractionErrors.push(`readTokenFromDb: ${(error as Error).message}`)
      return null
    }
  }

  private parseUserIds(raw: string | undefined): string[] {
    if (!raw) return []

    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed
      }
    } catch {
      const match = raw.match(/\[.*\]/)
      if (match) {
        try {
          const parsed = JSON.parse(match[0]) as unknown
          if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
            return parsed
          }
        } catch {}
      }
    }

    return []
  }

  isEncryptedValue(value: Buffer): boolean {
    if (!value || value.length < 4) return false
    const prefix = value.subarray(0, 3).toString('utf8')
    return prefix === 'v10' || prefix === 'v11'
  }

  private decryptCookie(encryptedValue: Buffer, dbPath: string): string | null {
    if (this.platform === 'win32') {
      return this.decryptWindowsCookie(encryptedValue, dbPath)
    } else if (this.platform === 'darwin') {
      return this.decryptMacCookie(encryptedValue)
    } else if (this.platform === 'linux') {
      return this.decryptLinuxCookie(encryptedValue)
    }

    return null
  }

  decryptMacCookie(encryptedData: Buffer): string | null {
    if (this.cachedKey) {
      const decrypted = this.decryptAESCBC(encryptedData, this.cachedKey)
      if (decrypted) return decrypted
    }

    for (const variant of KEYCHAIN_VARIANTS) {
      const password = this.execKeychainCommand(variant.service, variant.account)
      if (!password) continue

      const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
      const decrypted = this.decryptAESCBC(encryptedData, key)
      if (decrypted) {
        this.cachedKey = key
        return decrypted
      }
    }

    this.extractionErrors.push('decryptMacCookie: no keychain variant succeeded')
    return null
  }

  private execKeychainCommand(service: string, account: string): string | null {
    try {
      const safeService = service.replace(/"/g, '\\"')
      const safeAccount = account.replace(/"/g, '\\"')
      return execSync(
        `security find-generic-password -s "${safeService}" -a "${safeAccount}" -w 2>/dev/null`,
        { encoding: 'utf8' },
      ).trim()
    } catch {
      return null
    }
  }

  decryptLinuxCookie(encryptedData: Buffer): string | null {
    const prefix = encryptedData.subarray(0, 3).toString('utf8')

    if (prefix === 'v11') {
      for (const appName of LINUX_KEYRING_APP_NAMES) {
        const keyringPassword = this.lookupLinuxKeyringPassword(appName)
        if (!keyringPassword) continue

        const key = pbkdf2Sync(keyringPassword, 'saltysalt', 1, 16, 'sha1')
        const decrypted = this.decryptAESCBC(encryptedData, key)
        if (decrypted) return decrypted
      }
    }

    const key = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
    return this.decryptAESCBC(encryptedData, key)
  }

  lookupLinuxKeyringPassword(appName: string): string | null {
    try {
      return execSync(
        `secret-tool lookup xdg:schema chrome_libsecret_os_crypt_password_v2 application '${appName}'`,
        { timeout: 5000, encoding: 'utf8' },
      ).trim()
    } catch {
      return null
    }
  }

  decryptWindowsCookie(encryptedData: Buffer, dbPath: string): string | null {
    try {
      const localStatePath = this.findLocalStateForCookiePath(dbPath)
      if (!localStatePath || !existsSync(localStatePath)) return null

      const localState = JSON.parse(readFileSync(localStatePath, 'utf8')) as {
        os_crypt?: { encrypted_key?: string }
      }
      const encryptedKeyB64 = localState?.os_crypt?.encrypted_key
      if (!encryptedKeyB64) return null

      const encryptedKey = Buffer.from(encryptedKeyB64, 'base64')
      if (encryptedKey.subarray(0, 5).toString() !== 'DPAPI') return null

      const masterKey = this.decryptDPAPI(encryptedKey.subarray(5))
      if (!masterKey) return null

      return this.decryptAESGCM(encryptedData, masterKey)
    } catch {
      this.extractionErrors.push('decryptWindowsCookie: failed')
      return null
    }
  }

  private findLocalStateForCookiePath(cookiePath: string): string | null {
    const parts = cookiePath.split(/[/\\]/)
    for (let levels = 2; levels <= 4; levels++) {
      if (parts.length < levels) break
      const base = parts.slice(0, parts.length - levels).join('/')
      const candidate = join(base, 'Local State')
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  private decryptDPAPI(encryptedBlob: Buffer): Buffer | null {
    try {
      const b64 = encryptedBlob.toString('base64')
      const script = [
        'Add-Type -AssemblyName System.Security',
        `$d=[System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String("${b64}"),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
        '[Convert]::ToBase64String($d)',
      ].join(';')

      const encodedCommand = Buffer.from(script, 'utf16le').toString('base64')
      const result = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encodedCommand}`, {
        encoding: 'utf8',
        timeout: 10000,
      }).trim()

      return Buffer.from(result, 'base64')
    } catch {
      this.extractionErrors.push('decryptDPAPI: PowerShell decryption failed')
      return null
    }
  }

  decryptAESCBC(encryptedData: Buffer, key: Buffer): string | null {
    try {
      const ciphertext = encryptedData.subarray(3)
      const iv = Buffer.alloc(16, 0x20)

      const decipher = createDecipheriv('aes-128-cbc', key, iv)
      decipher.setAutoPadding(true)

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

      // Chromium v130+ prepends a 32-byte integrity hash before the actual cookie value
      if (decrypted.length > 32) {
        const hasNonPrintablePrefix = decrypted.subarray(0, 32).some((b) => b < 0x20 || b > 0x7e)
        if (hasNonPrintablePrefix) {
          return decrypted.subarray(32).toString('utf8')
        }
      }

      return decrypted.toString('utf8')
    } catch {
      return null
    }
  }

  private decryptAESGCM(encryptedData: Buffer, key: Buffer): string | null {
    try {
      // Format: v10 (3 bytes) + IV (12 bytes) + ciphertext + auth tag (16 bytes)
      if (encryptedData.length < 3 + 12 + 16) return null

      const iv = encryptedData.subarray(3, 15)
      const authTag = encryptedData.subarray(-16)
      const ciphertext = encryptedData.subarray(15, -16)

      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(authTag)

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return decrypted.toString('utf8')
    } catch {
      return null
    }
  }
}
