import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface NotionCredentials {
  token_v2: string
  user_id?: string
  user_ids?: string[]
  accounts?: Array<{
    token_v2: string
    user_id?: string
    user_ids?: string[]
  }>
}

export interface CredentialConfig {
  credentials: NotionCredentials | null
}

export function getDefaultConfigDir(): string {
  const override = process.env.VIBE_NOTION_CONFIG_DIR
  if (override && override.length > 0) {
    return override
  }
  return join(homedir(), '.config', 'vibe-notion')
}

export class CredentialManager {
  private configDir: string
  private credentialsPath: string

  constructor(configDir?: string) {
    this.configDir = configDir ?? getDefaultConfigDir()
    this.credentialsPath = join(this.configDir, 'credentials.json')
  }

  getConfigDir(): string {
    return this.configDir
  }

  async load(): Promise<CredentialConfig> {
    if (!existsSync(this.credentialsPath)) {
      return { credentials: null }
    }

    try {
      const content = await readFile(this.credentialsPath, 'utf8')
      return JSON.parse(content) as CredentialConfig
    } catch {
      return { credentials: null }
    }
  }

  async save(config: CredentialConfig): Promise<void> {
    await mkdir(this.configDir, { recursive: true })
    await writeFile(this.credentialsPath, JSON.stringify(config, null, 2))
    await chmod(this.credentialsPath, 0o600)
  }

  async getCredentials(): Promise<NotionCredentials | null> {
    const config = await this.load()
    return config.credentials
  }

  async setCredentials(creds: NotionCredentials): Promise<void> {
    await this.save({ credentials: creds })
  }

  async remove(): Promise<void> {
    await rm(this.credentialsPath, { force: true })
  }
}
