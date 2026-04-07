import { Command } from 'commander'

import { internalRequest } from '@/platforms/notion/client'
import type { NotionCredentials } from '@/platforms/notion/credential-manager'
import { handleNotionError } from '@/shared/utils/error-handler'
import { formatOutput } from '@/shared/utils/output'

import { type CommandOptions, getCredentialsOrExit } from './helpers'

type SpaceValue = {
  id: string
  name?: string
  icon?: string
  plan_type?: string
  created_time?: number
  [key: string]: unknown
}

type SpaceViewPointer = {
  id: string
  table: string
  spaceId: string
}

type GetSpacesUserEntry = {
  space?: Record<string, unknown>
  user_root?: Record<string, unknown>
  [key: string]: unknown
}

type GetSpacesResponse = Record<string, GetSpacesUserEntry>

type WorkspaceEntry = {
  id: string
  name?: string
  icon?: string
  plan_type?: string
  role: 'member' | 'guest'
}

// getSpaces v3 wraps records as { value: { value: {...}, role } } instead of { value: {...} }
function extractSpaceValue(record: unknown): SpaceValue | undefined {
  const rec = record as Record<string, unknown> | undefined
  if (!rec?.value) return undefined
  const outer = rec.value as Record<string, unknown>
  if (typeof outer.role === 'string' && outer.value !== undefined) {
    return outer.value as SpaceValue
  }
  return outer as unknown as SpaceValue
}

function extractSpaceViewPointers(entry: GetSpacesUserEntry, userId: string): SpaceViewPointer[] {
  const userRootRecord = (entry.user_root as Record<string, unknown> | undefined)?.[userId]
  if (!userRootRecord) return []
  const root = userRootRecord as Record<string, unknown>
  const outer = root.value as Record<string, unknown> | undefined
  if (!outer) return []
  const inner = typeof outer.role === 'string' ? (outer.value as Record<string, unknown>) : outer
  return (inner?.space_view_pointers as SpaceViewPointer[]) ?? []
}

function getAccountTokens(creds: NotionCredentials): string[] {
  const tokens = [creds.token_v2]

  for (const account of creds.accounts ?? []) {
    if (tokens.includes(account.token_v2)) continue
    tokens.push(account.token_v2)
  }

  return tokens
}

async function getSpacesResponses(creds: NotionCredentials): Promise<GetSpacesResponse[]> {
  const responses: GetSpacesResponse[] = []
  const errors: string[] = []

  for (const token of getAccountTokens(creds)) {
    try {
      const response = (await internalRequest(token, 'getSpaces', {})) as GetSpacesResponse
      responses.push(response)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (responses.length === 0 && errors.length > 0) {
    throw new Error(errors[0])
  }

  return responses
}

async function listAction(options: CommandOptions): Promise<void> {
  try {
    const creds = await getCredentialsOrExit()
    const responses = await getSpacesResponses(creds)

    const seen = new Set<string>()
    const workspaces: WorkspaceEntry[] = []

    for (const response of responses) {
      for (const entry of Object.values(response)) {
        for (const record of Object.values(entry.space ?? {})) {
          const space = extractSpaceValue(record)
          if (!space?.id) continue
          if (seen.has(space.id)) continue
          seen.add(space.id)
          workspaces.push({
            id: space.id,
            name: space.name,
            icon: space.icon,
            plan_type: space.plan_type,
            role: 'member',
          })
        }
      }
    }

    for (const response of responses) {
      for (const [userId, entry] of Object.entries(response)) {
        const pointers = extractSpaceViewPointers(entry, userId)
        for (const pointer of pointers) {
          if (seen.has(pointer.spaceId)) continue
          seen.add(pointer.spaceId)
          workspaces.push({
            id: pointer.spaceId,
            role: 'guest',
          })
        }
      }
    }

    console.log(formatOutput(workspaces, options.pretty))
  } catch (error) {
    handleNotionError(error)
  }
}

export const workspaceCommand = new Command('workspace')
  .description('Workspace commands')
  .addCommand(
    new Command('list')
      .description('List workspaces accessible to current user')
      .option('--pretty', 'Pretty print JSON output')
      .action(listAction),
  )
