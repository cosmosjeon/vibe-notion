import { Command } from 'commander'

import { internalRequest } from '@/platforms/notion/client'
import type { NotionCredentials } from '@/platforms/notion/credential-manager'
import { handleNotionError } from '@/shared/utils/error-handler'
import { formatNotionId } from '@/shared/utils/id'
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

type SyncRecordValuesResponse = {
  recordMap?: Record<string, Record<string, Record<string, unknown>> | undefined>
}

const SPACE_ID_PROBE_TABLES = ['block', 'collection', 'collection_view'] as const

function extractRecordInner(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!record) return undefined
  const outer = record.value as Record<string, unknown> | undefined
  return typeof outer?.role === 'string' ? (outer.value as Record<string, unknown>) : outer
}

function extractSpaceIdFromRecord(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined
  const inner = extractRecordInner(record)
  const innerSpaceId = typeof inner?.space_id === 'string' ? (inner.space_id as string) : undefined
  const topSpaceId = typeof record.spaceId === 'string' ? (record.spaceId as string) : undefined
  return innerSpaceId ?? topSpaceId
}

function recordIdMatches(record: Record<string, unknown> | undefined, targetId: string): boolean {
  const inner = extractRecordInner(record)
  return typeof inner?.id === 'string' && (inner.id as string) === targetId
}

async function resolveSpaceIdForToken(token: string, targetId: string): Promise<{ spaceId?: string; error?: Error }> {
  try {
    const result = (await internalRequest(token, 'syncRecordValues', {
      requests: SPACE_ID_PROBE_TABLES.map((table) => ({ pointer: { table, id: targetId }, version: -1 })),
    })) as SyncRecordValuesResponse

    for (const table of SPACE_ID_PROBE_TABLES) {
      const records = result.recordMap?.[table]
      if (!records) continue
      const direct = records[targetId]
      if (direct) {
        const spaceId = extractSpaceIdFromRecord(direct)
        if (spaceId) return { spaceId }
      }
      for (const record of Object.values(records)) {
        if (!recordIdMatches(record, targetId)) continue
        const spaceId = extractSpaceIdFromRecord(record)
        if (spaceId) return { spaceId }
      }
    }
    return {}
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
}

async function lookupWorkspaceName(token: string, workspaceId: string): Promise<string | undefined> {
  try {
    const response = (await internalRequest(token, 'getSpaces', {})) as GetSpacesResponse
    for (const entry of Object.values(response)) {
      for (const record of Object.values(entry.space ?? {})) {
        const space = extractSpaceValue(record)
        if (space?.id === workspaceId) {
          return space.name
        }
      }
    }
  } catch {}
  return undefined
}

function extractPageIdFromInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed.includes('/')) return trimmed
  const withoutQuery = trimmed.split('?', 1)[0]
  const segments = withoutQuery.split('/').filter(Boolean)
  const last = segments[segments.length - 1] ?? ''
  const tail = last.includes('-') ? (last.split('-').pop() ?? last) : last
  return tail || trimmed
}

async function resolveAction(rawInput: string, options: CommandOptions): Promise<void> {
  const pageId = formatNotionId(extractPageIdFromInput(rawInput))
  try {
    const creds = await getCredentialsOrExit()
    const tokens = getAccountTokens(creds)

    let workspaceId: string | undefined
    let matchedToken: string | undefined
    let lastError: Error | undefined
    for (const token of tokens) {
      const { spaceId, error } = await resolveSpaceIdForToken(token, pageId)
      if (spaceId) {
        workspaceId = spaceId
        matchedToken = token
        break
      }
      if (error) lastError = error
    }

    if (!workspaceId || !matchedToken) {
      const suffix = lastError ? ` Last error: ${lastError.message}` : ''
      throw new Error(`Could not resolve workspace for page: ${pageId}.${suffix}`)
    }

    const name = await lookupWorkspaceName(matchedToken, workspaceId)
    const output = {
      page_id: pageId,
      workspace_id: workspaceId,
      ...(name ? { workspace_name: name } : {}),
    }

    console.log(formatOutput(output, options.pretty))
  } catch (error) {
    handleNotionError(error)
  }
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
  .addCommand(
    new Command('resolve')
      .description('Resolve the workspace ID that owns a given page or block')
      .argument('<page_id>', 'Page or block ID')
      .option('--pretty', 'Pretty print JSON output')
      .action(resolveAction),
  )
