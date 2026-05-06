import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { CredentialManager, getDefaultConfigDir } from './credential-manager'

describe('CredentialManager', () => {
  let configDir: string
  let manager: CredentialManager

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'vibe-notion-credentials-'))
    manager = new CredentialManager(configDir)
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  test('load returns empty config when file does not exist', async () => {
    const config = await manager.load()
    expect(config).toEqual({ credentials: null })
  })

  test('save and load round-trip credentials', async () => {
    const config = {
      credentials: {
        token_v2: 'v02%3Atoken',
        user_id: 'user-123',
      },
    }

    await manager.save(config)
    const loaded = await manager.load()

    expect(loaded).toEqual(config)
  })

  test('save creates file with 0600 permissions', async () => {
    await manager.save({ credentials: { token_v2: 'v02%3Atoken' } })

    const credentialsPath = join(configDir, 'credentials.json')
    expect(existsSync(credentialsPath)).toBe(true)

    const stats = await Bun.file(credentialsPath).stat()
    const mode = stats?.mode ?? 0
    expect(mode & 0o777).toBe(0o600)
  })

  test('getCredentials returns null when no credentials are stored', async () => {
    const creds = await manager.getCredentials()
    expect(creds).toBeNull()
  })

  test('setCredentials stores and getCredentials returns values', async () => {
    await manager.setCredentials({ token_v2: 'v02%3Atoken', user_id: 'user-777' })
    const creds = await manager.getCredentials()

    expect(creds).toEqual({ token_v2: 'v02%3Atoken', user_id: 'user-777' })
  })

  test('setCredentials preserves extracted accounts metadata', async () => {
    await manager.setCredentials({
      token_v2: 'v02%3Atoken',
      user_id: 'user-777',
      accounts: [
        { token_v2: 'v02%3Atoken', user_id: 'user-777' },
        { token_v2: 'v02%3Atoken-2', user_id: 'user-888' },
      ],
    })

    const creds = await manager.getCredentials()

    expect(creds).toEqual({
      token_v2: 'v02%3Atoken',
      user_id: 'user-777',
      accounts: [
        { token_v2: 'v02%3Atoken', user_id: 'user-777' },
        { token_v2: 'v02%3Atoken-2', user_id: 'user-888' },
      ],
    })
  })

  test('remove deletes credential file', async () => {
    const credentialsPath = join(configDir, 'credentials.json')
    await manager.setCredentials({ token_v2: 'v02%3Atoken' })
    expect(existsSync(credentialsPath)).toBe(true)

    await manager.remove()

    expect(existsSync(credentialsPath)).toBe(false)
  })

  test('load returns empty config when file contains invalid JSON', async () => {
    writeFileSync(join(configDir, 'credentials.json'), '{ broken json')
    const config = await manager.load()
    expect(config).toEqual({ credentials: null })
  })

  test('load returns empty config when file is empty', async () => {
    writeFileSync(join(configDir, 'credentials.json'), '')
    const config = await manager.load()
    expect(config).toEqual({ credentials: null })
  })

  test('getCredentials returns null when file is corrupted', async () => {
    writeFileSync(join(configDir, 'credentials.json'), 'not json at all')
    const creds = await manager.getCredentials()
    expect(creds).toBeNull()
  })

  test('getConfigDir returns the configured directory', () => {
    expect(manager.getConfigDir()).toBe(configDir)
  })
})

describe('getDefaultConfigDir', () => {
  const originalEnv = process.env.VIBE_NOTION_CONFIG_DIR

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VIBE_NOTION_CONFIG_DIR
    } else {
      process.env.VIBE_NOTION_CONFIG_DIR = originalEnv
    }
  })

  test('returns ~/.config/vibe-notion when env var is unset', () => {
    delete process.env.VIBE_NOTION_CONFIG_DIR
    expect(getDefaultConfigDir()).toBe(join(homedir(), '.config', 'vibe-notion'))
  })

  test('returns ~/.config/vibe-notion when env var is empty', () => {
    process.env.VIBE_NOTION_CONFIG_DIR = ''
    expect(getDefaultConfigDir()).toBe(join(homedir(), '.config', 'vibe-notion'))
  })

  test('returns env var value when set', () => {
    process.env.VIBE_NOTION_CONFIG_DIR = '/custom/config/path'
    expect(getDefaultConfigDir()).toBe('/custom/config/path')
  })
})

describe('CredentialManager with VIBE_NOTION_CONFIG_DIR env var', () => {
  const originalEnv = process.env.VIBE_NOTION_CONFIG_DIR
  let envConfigDir: string

  beforeEach(() => {
    envConfigDir = mkdtempSync(join(tmpdir(), 'vibe-notion-env-credentials-'))
    process.env.VIBE_NOTION_CONFIG_DIR = envConfigDir
  })

  afterEach(() => {
    rmSync(envConfigDir, { recursive: true, force: true })
    if (originalEnv === undefined) {
      delete process.env.VIBE_NOTION_CONFIG_DIR
    } else {
      process.env.VIBE_NOTION_CONFIG_DIR = originalEnv
    }
  })

  test('uses env var as default config dir when constructor arg omitted', async () => {
    const manager = new CredentialManager()
    expect(manager.getConfigDir()).toBe(envConfigDir)

    await manager.setCredentials({ token_v2: 'v02%3Atoken', user_id: 'user-env' })
    expect(existsSync(join(envConfigDir, 'credentials.json'))).toBe(true)

    const creds = await manager.getCredentials()
    expect(creds).toEqual({ token_v2: 'v02%3Atoken', user_id: 'user-env' })
  })

  test('explicit constructor arg overrides env var', () => {
    const explicitDir = mkdtempSync(join(tmpdir(), 'vibe-notion-explicit-'))
    try {
      const manager = new CredentialManager(explicitDir)
      expect(manager.getConfigDir()).toBe(explicitDir)
    } finally {
      rmSync(explicitDir, { recursive: true, force: true })
    }
  })
})
