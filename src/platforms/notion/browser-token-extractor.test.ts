import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BrowserTokenExtractor } from './browser-token-extractor'

function createCookiesDb(dbPath: string, rows: Array<Record<string, unknown>>): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE cookies (
      name TEXT,
      value TEXT,
      encrypted_value BLOB,
      host_key TEXT,
      last_access_utc INTEGER
    );
  `)

  const insert = db.query(
    'INSERT INTO cookies (name, value, encrypted_value, host_key, last_access_utc) VALUES (?, ?, ?, ?, ?)',
  )

  for (const row of rows) {
    insert.run(
      row.name as string,
      (row.value as string | null) ?? '',
      (row.encrypted_value as Uint8Array | null) ?? new Uint8Array(),
      row.host_key as string,
      row.last_access_utc as number,
    )
  }

  db.close()
}

function createBrowserProfile(baseDir: string, browserRelPath: string, profileName: string): string {
  const profileDir = join(baseDir, browserRelPath, profileName)
  mkdirSync(profileDir, { recursive: true })
  return profileDir
}

describe('BrowserTokenExtractor', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tempDirs.length = 0
  })

  test('getBrowserCookiePaths returns paths for all supported browsers on darwin', () => {
    const extractor = new BrowserTokenExtractor('darwin')
    const paths = extractor.getBrowserCookiePaths()

    expect(paths.length).toBeGreaterThan(0)
    expect(paths.some((p) => p.includes('Google/Chrome'))).toBe(true)
    expect(paths.some((p) => p.includes('Microsoft Edge'))).toBe(true)
    expect(paths.some((p) => p.includes('Arc'))).toBe(true)
    expect(paths.some((p) => p.includes('BraveSoftware'))).toBe(true)
    expect(paths.some((p) => p.includes('Vivaldi'))).toBe(true)
    expect(paths.some((p) => p.includes('Chromium'))).toBe(true)
  })

  test('getBrowserCookiePaths returns paths for linux', () => {
    const extractor = new BrowserTokenExtractor('linux')
    const paths = extractor.getBrowserCookiePaths()

    expect(paths.length).toBeGreaterThan(0)
    expect(paths.some((p) => p.includes('google-chrome'))).toBe(true)
    expect(paths.some((p) => p.includes('microsoft-edge'))).toBe(true)
  })

  test('getBrowserCookiePaths returns paths for win32', () => {
    const extractor = new BrowserTokenExtractor('win32')
    const paths = extractor.getBrowserCookiePaths()

    expect(paths.length).toBeGreaterThan(0)
    expect(paths.some((p) => p.includes('Google'))).toBe(true)
  })

  test('getBrowserBasePath returns null for unsupported platform', () => {
    const extractor = new BrowserTokenExtractor('freebsd' as NodeJS.Platform)
    const result = extractor.getBrowserBasePath({ name: 'Chrome', darwin: 'Chrome', linux: 'chrome', win32: 'Chrome' })
    expect(result).toBeNull()
  })

  test('getBrowserBasePath returns null when browser has empty path for platform', () => {
    const extractor = new BrowserTokenExtractor('linux')
    const result = extractor.getBrowserBasePath({ name: 'Arc', darwin: 'Arc/User Data', linux: '', win32: 'Arc/User Data' })
    expect(result).toBeNull()
  })

  test('extract returns null when no browser cookies exist', async () => {
    const extractor = new BrowserTokenExtractor('darwin')
    const result = await extractor.extract()
    expect(result).toBeNull()
  })

  test('extract finds token_v2 from a plaintext browser cookie', async () => {
    // given
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-test-'))
    tempDirs.push(homeBase)

    const profileDir = createBrowserProfile(homeBase, 'TestBrowser', 'Default')
    const cookiePath = join(profileDir, 'Cookies')

    createCookiesDb(cookiePath, [
      {
        name: 'token_v2',
        value: 'v02%3Abrowser-token-value',
        encrypted_value: new Uint8Array(),
        host_key: '.notion.so',
        last_access_utc: 1,
      },
      {
        name: 'notion_user_id',
        value: 'user-abc',
        encrypted_value: new Uint8Array(),
        host_key: '.notion.so',
        last_access_utc: 1,
      },
    ])

    // when
    class TestExtractor extends BrowserTokenExtractor {
      override getBrowserCookiePaths(): string[] {
        return [cookiePath]
      }
    }

    const extractor = new TestExtractor('darwin')
    const result = await extractor.extract()

    // then
    expect(result).toEqual({ token_v2: 'v02%3Abrowser-token-value', user_id: 'user-abc' })
  })

  test('extract finds token from Network/Cookies path', async () => {
    // given
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-network-'))
    tempDirs.push(homeBase)

    const profileDir = createBrowserProfile(homeBase, 'TestBrowser', 'Default')
    const networkDir = join(profileDir, 'Network')
    mkdirSync(networkDir, { recursive: true })
    const cookiePath = join(networkDir, 'Cookies')

    createCookiesDb(cookiePath, [
      {
        name: 'token_v2',
        value: 'v02%3Anetwork-token',
        encrypted_value: new Uint8Array(),
        host_key: 'www.notion.so',
        last_access_utc: 1,
      },
    ])

    // when
    class TestExtractor extends BrowserTokenExtractor {
      override getBrowserCookiePaths(): string[] {
        return [cookiePath]
      }
    }

    const extractor = new TestExtractor('darwin')
    const result = await extractor.extract()

    // then
    expect(result).toEqual({ token_v2: 'v02%3Anetwork-token' })
  })

  test('extract returns null when cookie DB has no notion cookies', async () => {
    // given
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-empty-'))
    tempDirs.push(homeBase)

    const profileDir = createBrowserProfile(homeBase, 'TestBrowser', 'Default')
    const cookiePath = join(profileDir, 'Cookies')

    createCookiesDb(cookiePath, [
      {
        name: 'other_cookie',
        value: 'irrelevant',
        encrypted_value: new Uint8Array(),
        host_key: '.example.com',
        last_access_utc: 1,
      },
    ])

    // when
    class TestExtractor extends BrowserTokenExtractor {
      override getBrowserCookiePaths(): string[] {
        return [cookiePath]
      }
    }

    const extractor = new TestExtractor('darwin')
    const result = await extractor.extract()

    // then
    expect(result).toBeNull()
  })

  test('extract decrypts v10 encrypted cookie on darwin', async () => {
    // given
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-v10-'))
    tempDirs.push(homeBase)

    const profileDir = createBrowserProfile(homeBase, 'TestBrowser', 'Default')
    const cookiePath = join(profileDir, 'Cookies')

    const key = Buffer.from('1234567890abcdef')
    const iv = Buffer.alloc(16, 0x20)
    const plaintext = 'v02%3Aencrypted-browser-token'
    const cipher = createCipheriv('aes-128-cbc', key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const encrypted = Buffer.concat([Buffer.from('v10'), ciphertext])

    createCookiesDb(cookiePath, [
      {
        name: 'token_v2',
        value: '',
        encrypted_value: new Uint8Array(encrypted),
        host_key: '.notion.so',
        last_access_utc: 1,
      },
    ])

    // when
    class TestExtractor extends BrowserTokenExtractor {
      override getBrowserCookiePaths(): string[] {
        return [cookiePath]
      }
      override decryptMacCookie(encryptedData: Buffer): string | null {
        return this.decryptAESCBC(encryptedData, key)
      }
    }

    const extractor = new TestExtractor('darwin')
    const result = await extractor.extract()

    // then
    expect(result).toEqual({ token_v2: 'v02%3Aencrypted-browser-token' })
  })

  test('extract includes user_ids from notion_users cookie', async () => {
    // given
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-multi-'))
    tempDirs.push(homeBase)

    const profileDir = createBrowserProfile(homeBase, 'TestBrowser', 'Default')
    const cookiePath = join(profileDir, 'Cookies')

    createCookiesDb(cookiePath, [
      {
        name: 'token_v2',
        value: 'v02%3Atest-token',
        encrypted_value: new Uint8Array(),
        host_key: '.notion.so',
        last_access_utc: 3,
      },
      {
        name: 'notion_user_id',
        value: 'user-aaa',
        encrypted_value: new Uint8Array(),
        host_key: '.notion.so',
        last_access_utc: 2,
      },
      {
        name: 'notion_users',
        value: '["user-aaa","user-bbb"]',
        encrypted_value: new Uint8Array(),
        host_key: '.notion.so',
        last_access_utc: 1,
      },
    ])

    // when
    class TestExtractor extends BrowserTokenExtractor {
      override getBrowserCookiePaths(): string[] {
        return [cookiePath]
      }
    }

    const extractor = new TestExtractor('darwin')
    const result = await extractor.extract()

    // then
    expect(result).toEqual({
      token_v2: 'v02%3Atest-token',
      user_id: 'user-aaa',
      user_ids: ['user-aaa', 'user-bbb'],
    })
  })

  test('extract omits user_ids when notion_users cookie is missing', async () => {
    // given
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-no-users-'))
    tempDirs.push(homeBase)

    const profileDir = createBrowserProfile(homeBase, 'TestBrowser', 'Default')
    const cookiePath = join(profileDir, 'Cookies')

    createCookiesDb(cookiePath, [
      {
        name: 'token_v2',
        value: 'v02%3Atest-token',
        encrypted_value: new Uint8Array(),
        host_key: '.notion.so',
        last_access_utc: 1,
      },
    ])

    // when
    class TestExtractor extends BrowserTokenExtractor {
      override getBrowserCookiePaths(): string[] {
        return [cookiePath]
      }
    }

    const extractor = new TestExtractor('darwin')
    const result = await extractor.extract()

    // then
    expect(result).toEqual({ token_v2: 'v02%3Atest-token' })
    expect(result?.user_ids).toBeUndefined()
  })

  test('extract prefers the newest matching Notion cookie row', async () => {
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-latest-'))
    tempDirs.push(homeBase)

    const profileDir = createBrowserProfile(homeBase, 'TestBrowser', 'Default')
    const cookiePath = join(profileDir, 'Cookies')

    createCookiesDb(cookiePath, [
      {
        name: 'token_v2',
        value: 'v02%3Astale-token',
        encrypted_value: new Uint8Array(),
        host_key: '.notion.so',
        last_access_utc: 1,
      },
      {
        name: 'token_v2',
        value: 'v02%3Afresh-token',
        encrypted_value: new Uint8Array(),
        host_key: 'www.notion.so',
        last_access_utc: 10,
      },
    ])

    class TestExtractor extends BrowserTokenExtractor {
      override getBrowserCookiePaths(): string[] {
        return [cookiePath]
      }
    }

    const extractor = new TestExtractor('darwin')
    const result = await extractor.extract()

    expect(result).toEqual({ token_v2: 'v02%3Afresh-token' })
  })

  test('isEncryptedValue detects v10 prefix', () => {
    const extractor = new BrowserTokenExtractor('darwin')
    expect(extractor.isEncryptedValue(Buffer.from('v10abcdef'))).toBe(true)
  })

  test('isEncryptedValue detects v11 prefix', () => {
    const extractor = new BrowserTokenExtractor('darwin')
    expect(extractor.isEncryptedValue(Buffer.from('v11abcdef'))).toBe(true)
  })

  test('isEncryptedValue returns false for short buffer', () => {
    const extractor = new BrowserTokenExtractor('darwin')
    expect(extractor.isEncryptedValue(Buffer.from('v1'))).toBe(false)
  })

  test('isEncryptedValue returns false for plaintext', () => {
    const extractor = new BrowserTokenExtractor('darwin')
    expect(extractor.isEncryptedValue(Buffer.from('v02%3Atoken'))).toBe(false)
  })

  test('decryptAESCBC decrypts with correct key', () => {
    // given
    const key = Buffer.from('1234567890abcdef')
    const iv = Buffer.alloc(16, 0x20)
    const plaintext = 'v02%3Atest-value'
    const cipher = createCipheriv('aes-128-cbc', key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const encrypted = Buffer.concat([Buffer.from('v10'), ciphertext])

    // when
    const extractor = new BrowserTokenExtractor('darwin')
    const result = extractor.decryptAESCBC(encrypted, key)

    // then
    expect(result).toBe(plaintext)
  })

  test('decryptAESCBC returns null with wrong key', () => {
    // given
    const correctKey = Buffer.from('1234567890abcdef')
    const wrongKey = Buffer.from('abcdef1234567890')
    const iv = Buffer.alloc(16, 0x20)
    const cipher = createCipheriv('aes-128-cbc', correctKey, iv)
    const ciphertext = Buffer.concat([cipher.update('test', 'utf8'), cipher.final()])
    const encrypted = Buffer.concat([Buffer.from('v10'), ciphertext])

    // when
    const extractor = new BrowserTokenExtractor('darwin')
    const result = extractor.decryptAESCBC(encrypted, wrongKey)

    // then
    expect(result).toBeNull()
  })

  test('decryptAESCBC strips Chromium v130+ integrity hash prefix', () => {
    // given
    const key = Buffer.from('1234567890abcdef')
    const iv = Buffer.alloc(16, 0x20)
    const integrityHash = Buffer.alloc(32, 0x01)
    const actualValue = 'v02%3Aactual-cookie-value'
    const plaintextWithHash = Buffer.concat([integrityHash, Buffer.from(actualValue)])

    const cipher = createCipheriv('aes-128-cbc', key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintextWithHash), cipher.final()])
    const encrypted = Buffer.concat([Buffer.from('v10'), ciphertext])

    // when
    const extractor = new BrowserTokenExtractor('darwin')
    const result = extractor.decryptAESCBC(encrypted, key)

    // then
    expect(result).toBe(actualValue)
  })

  test('decryptLinuxCookie decrypts v10 with peanuts key', () => {
    // given
    const key = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
    const iv = Buffer.alloc(16, 0x20)
    const plaintext = 'v02%3Alinux-token'
    const cipher = createCipheriv('aes-128-cbc', key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const encrypted = Buffer.concat([Buffer.from('v10'), ciphertext])

    // when
    const extractor = new BrowserTokenExtractor('linux')
    const result = extractor.decryptLinuxCookie(encrypted)

    // then
    expect(result).toBe(plaintext)
  })

  test('decryptLinuxCookie tries multiple keyring app names for v11 cookies', () => {
    const keyringKey = pbkdf2Sync('brave-secret', 'saltysalt', 1, 16, 'sha1')
    const iv = Buffer.alloc(16, 0x20)
    const plaintext = 'v02%3Av11-linux-token'
    const cipher = createCipheriv('aes-128-cbc', keyringKey, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const encrypted = Buffer.concat([Buffer.from('v11'), ciphertext])

    class TestExtractor extends BrowserTokenExtractor {
      override lookupLinuxKeyringPassword(appName: string): string | null {
        return appName === 'Brave' ? 'brave-secret' : null
      }
    }

    const extractor = new TestExtractor('linux')
    const result = extractor.decryptLinuxCookie(encrypted)

    expect(result).toBe(plaintext)
  })

  test('decryptWindowsCookie decrypts AES-256-GCM with Local State master key', () => {
    // given
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-win-'))
    tempDirs.push(homeBase)

    const browserDir = join(homeBase, 'Google', 'Chrome', 'User Data')
    mkdirSync(browserDir, { recursive: true })

    const masterKey = randomBytes(32)
    const dpapiPayload = Buffer.from('fake-dpapi-encrypted-key')
    const encryptedKeyWithPrefix = Buffer.concat([Buffer.from('DPAPI'), dpapiPayload])
    const localState = { os_crypt: { encrypted_key: encryptedKeyWithPrefix.toString('base64') } }
    writeFileSync(join(browserDir, 'Local State'), JSON.stringify(localState))

    const tokenPlaintext = 'v02%3Awindows-browser-token'
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', masterKey, nonce)
    const ciphertext = Buffer.concat([cipher.update(tokenPlaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const encrypted = Buffer.concat([Buffer.from('v10'), nonce, ciphertext, tag])

    const cookieDir = join(browserDir, 'Default')
    mkdirSync(cookieDir, { recursive: true })

    // when
    const extractor = new BrowserTokenExtractor('win32')
    const result = extractor.decryptWindowsCookie(encrypted, join(cookieDir, 'Cookies'))
    expect(result).toBeNull()
  })

  test('getErrors returns empty array initially', () => {
    const extractor = new BrowserTokenExtractor('darwin')
    expect(extractor.getErrors()).toEqual([])
  })

  test('getErrors returns a copy that cannot mutate internal state', () => {
    const extractor = new BrowserTokenExtractor('darwin')
    const errors = extractor.getErrors()
    errors.push('fake error')
    expect(extractor.getErrors()).toEqual([])
  })

  test('extract handles corrupt cookie database gracefully', async () => {
    // given
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-corrupt-'))
    tempDirs.push(homeBase)

    const profileDir = createBrowserProfile(homeBase, 'TestBrowser', 'Default')
    const cookiePath = join(profileDir, 'Cookies')
    writeFileSync(cookiePath, 'not a sqlite database')

    // when
    class TestExtractor extends BrowserTokenExtractor {
      override getBrowserCookiePaths(): string[] {
        return [cookiePath]
      }
    }

    const extractor = new TestExtractor('darwin')
    const result = await extractor.extract()

    // then
    expect(result).toBeNull()
    expect(extractor.getErrors().length).toBeGreaterThan(0)
  })

  test('extract discovers Profile N directories', async () => {
    // given
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-profiles-'))
    tempDirs.push(homeBase)

    const browserBase = join(homeBase, 'TestBrowser')
    mkdirSync(join(browserBase, 'Default'), { recursive: true })
    mkdirSync(join(browserBase, 'Profile 1'), { recursive: true })
    mkdirSync(join(browserBase, 'Profile 2'), { recursive: true })
    mkdirSync(join(browserBase, 'NotAProfile'), { recursive: true })

    const cookiePath = join(browserBase, 'Profile 1', 'Cookies')
    createCookiesDb(cookiePath, [
      {
        name: 'token_v2',
        value: 'v02%3Aprofile-1-token',
        encrypted_value: new Uint8Array(),
        host_key: '.notion.so',
        last_access_utc: 1,
      },
    ])

    // when
    class TestExtractor extends BrowserTokenExtractor {
      override getBrowserCookiePaths(): string[] {
        const paths: string[] = []
        for (const profile of ['Default', 'Profile 1', 'Profile 2']) {
          paths.push(join(browserBase, profile, 'Network', 'Cookies'))
          paths.push(join(browserBase, profile, 'Cookies'))
        }
        return paths
      }
    }

    const extractor = new TestExtractor('darwin')
    const result = await extractor.extract()

    // then
    expect(result).toEqual({ token_v2: 'v02%3Aprofile-1-token' })
  })

  test('extract parses notion_users from encrypted cookie with garbage prefix', async () => {
    // given
    const homeBase = mkdtempSync(join(tmpdir(), 'browser-enc-users-'))
    tempDirs.push(homeBase)

    const profileDir = createBrowserProfile(homeBase, 'TestBrowser', 'Default')
    const cookiePath = join(profileDir, 'Cookies')

    const key = Buffer.from('1234567890abcdef')
    const iv = Buffer.alloc(16, 0x20)
    const usersPlaintext = 'GARBAGE_PREFIX["user-111","user-222"]'
    const usersCipher = createCipheriv('aes-128-cbc', key, iv)
    const usersCiphertext = Buffer.concat([usersCipher.update(usersPlaintext, 'utf8'), usersCipher.final()])
    const usersEncrypted = Buffer.concat([Buffer.from('v10'), usersCiphertext])

    createCookiesDb(cookiePath, [
      {
        name: 'token_v2',
        value: 'v02%3Atest-token',
        encrypted_value: new Uint8Array(),
        host_key: '.notion.so',
        last_access_utc: 3,
      },
      {
        name: 'notion_users',
        value: '',
        encrypted_value: new Uint8Array(usersEncrypted),
        host_key: '.notion.so',
        last_access_utc: 1,
      },
    ])

    // when
    class TestExtractor extends BrowserTokenExtractor {
      override getBrowserCookiePaths(): string[] {
        return [cookiePath]
      }
      override decryptMacCookie(encryptedData: Buffer): string | null {
        return this.decryptAESCBC(encryptedData, key)
      }
    }

    const extractor = new TestExtractor('darwin')
    const result = await extractor.extract()

    // then
    expect(result?.token_v2).toBe('v02%3Atest-token')
    expect(result?.user_ids).toEqual(['user-111', 'user-222'])
  })
})
