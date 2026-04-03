import { randomUUID } from 'node:crypto'

import { getActiveUserId, internalRequest, setActiveSpaceId, setActiveUserId } from '@/platforms/notion/client'
import { CredentialManager, type NotionCredentials } from '@/platforms/notion/credential-manager'
import { collectBacklinkUserIds } from '@/platforms/notion/formatters'
import { TokenExtractor } from '@/platforms/notion/token-extractor'

export type CommandOptions = { pretty?: boolean }

type TeamRecord = {
  value?: {
    id: string
    name?: string
    space_id: string
    is_default?: boolean
  }
}

type SpaceViewPointer = {
  id: string
  table: string
  spaceId: string
}

type SpaceUserEntry = {
  space?: Record<string, unknown>
  team?: Record<string, TeamRecord>
  user_root?: Record<string, unknown>
}

type GetSpacesResponse = Record<string, SpaceUserEntry>

export function generateId(): string {
  return randomUUID()
}

export async function getCredentialsOrExit(): Promise<NotionCredentials> {
  const manager = new CredentialManager()
  const creds = await manager.getCredentials()
  if (creds) return creds

  // Auto-extract from Notion desktop app
  try {
    const extractor = new TokenExtractor()
    const extracted = await extractor.extract()
    if (extracted) {
      await manager.setCredentials(extracted)
      return extracted
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        error: `Auto-extraction failed: ${(error as Error).message}`,
        hint: 'Run: vibe-notion auth extract --debug',
      }),
    )
    process.exit(1)
  }

  console.error(JSON.stringify({ error: 'Not authenticated. Run: vibe-notion auth extract' }))
  process.exit(1)
}

export async function getCredentialsOrThrow(): Promise<NotionCredentials> {
  const manager = new CredentialManager()
  const creds = await manager.getCredentials()
  if (creds) return creds

  // Auto-extract from Notion desktop app
  try {
    const extractor = new TokenExtractor()
    const extracted = await extractor.extract()
    if (extracted) {
      await manager.setCredentials(extracted)
      return extracted
    }
  } catch (error) {
    throw new Error(`Auto-extraction failed: ${(error as Error).message}`)
  }

  throw new Error('Not authenticated. Run: vibe-notion auth extract')
}

export async function resolveSpaceId(tokenV2: string, blockId: string): Promise<string> {
  const result = (await internalRequest(tokenV2, 'syncRecordValues', {
    requests: [{ pointer: { table: 'block', id: blockId }, version: -1 }],
  })) as { recordMap: { block: Record<string, Record<string, unknown>> } }

  const raw = Object.values(result.recordMap.block)[0] as Record<string, unknown> | undefined
  const outer = raw?.value as Record<string, unknown> | undefined
  const inner = typeof outer?.role === 'string' ? (outer.value as Record<string, unknown>) : outer
  const spaceId = (inner?.space_id as string) ?? (raw?.spaceId as string)
  if (!spaceId) {
    throw new Error(`Could not resolve space ID for block: ${blockId}`)
  }
  return spaceId
}

function extractSpaceViewPointers(entry: SpaceUserEntry, userId: string): SpaceViewPointer[] {
  const userRootRecord = (entry.user_root as Record<string, unknown> | undefined)?.[userId]
  if (!userRootRecord) return []
  const root = userRootRecord as Record<string, unknown>
  const outer = root.value as Record<string, unknown> | undefined
  if (!outer) return []
  const inner = typeof outer.role === 'string' ? (outer.value as Record<string, unknown>) : outer
  return (inner?.space_view_pointers as SpaceViewPointer[]) ?? []
}

export async function resolveAndSetActiveUserId(tokenV2: string, workspaceId?: string): Promise<void> {
  if (!workspaceId) return

  if (!getActiveUserId()) {
    const manager = new CredentialManager()
    const creds = await manager.getCredentials()
    if (creds?.user_id) {
      setActiveUserId(creds.user_id)
    }
  }

  const response = (await internalRequest(tokenV2, 'getSpaces', {})) as GetSpacesResponse

  for (const [userId, entry] of Object.entries(response)) {
    if (entry.space && workspaceId in entry.space) {
      setActiveUserId(userId)
      setActiveSpaceId(workspaceId)
      return
    }
  }

  // Guest workspaces don't appear in entry.space; check space_view_pointers instead
  for (const [userId, entry] of Object.entries(response)) {
    const pointers = extractSpaceViewPointers(entry, userId)
    if (pointers.some((p) => p.spaceId === workspaceId)) {
      setActiveUserId(userId)
      setActiveSpaceId(workspaceId)
      return
    }
  }

  const memberIds = Object.values(response).flatMap((entry) => (entry.space ? Object.keys(entry.space) : []))
  const allPointerIds = Object.entries(response).flatMap(([userId, entry]) =>
    extractSpaceViewPointers(entry, userId).map((p) => p.spaceId),
  )
  const allIds = [...new Set([...memberIds, ...allPointerIds])]
  console.error(
    JSON.stringify({
      warning: `Workspace ${workspaceId} not found in your spaces`,
      available_workspace_ids: allIds,
      hint: 'Run: vibe-notion workspace list',
    }),
  )
}

export async function resolveDefaultTeamId(tokenV2: string, workspaceId: string): Promise<string | undefined> {
  const response = (await internalRequest(tokenV2, 'getSpaces', {})) as GetSpacesResponse

  for (const entry of Object.values(response)) {
    if (!entry.team) continue
    for (const team of Object.values(entry.team)) {
      if (team.value?.space_id === workspaceId && team.value?.is_default) {
        return team.value.id
      }
    }
  }
  return undefined
}

export async function resolveCollectionViewId(tokenV2: string, collectionId: string): Promise<string> {
  const collResult = (await internalRequest(tokenV2, 'syncRecordValues', {
    requests: [{ pointer: { table: 'collection', id: collectionId }, version: -1 }],
  })) as { recordMap: { collection: Record<string, { value: { parent_id: string } }> } }

  const coll = Object.values(collResult.recordMap.collection)[0]
  if (!coll?.value?.parent_id) {
    throw new Error(`Collection not found: ${collectionId}`)
  }

  const parentId = coll.value.parent_id
  const blockResult = (await internalRequest(tokenV2, 'syncRecordValues', {
    requests: [{ pointer: { table: 'block', id: parentId }, version: -1 }],
  })) as { recordMap: { block: Record<string, { value: { view_ids?: string[] } }> } }

  const parentBlock = Object.values(blockResult.recordMap.block)[0]
  const viewId = parentBlock?.value?.view_ids?.[0]
  if (!viewId) {
    throw new Error(`No views found for collection: ${collectionId}`)
  }
  return viewId
}

type UserRecord = { value?: { name?: string } }

export async function resolveBacklinkUsers(
  tokenV2: string,
  backlinksResponse: Record<string, unknown>,
): Promise<Record<string, string>> {
  const userIds = collectBacklinkUserIds(backlinksResponse)
  if (userIds.length === 0) return {}

  const response = (await internalRequest(tokenV2, 'syncRecordValues', {
    requests: userIds.map((id) => ({ pointer: { table: 'notion_user', id }, version: -1 })),
  })) as { recordMap: { notion_user?: Record<string, UserRecord> } }

  const lookup: Record<string, string> = {}
  const userMap = response.recordMap.notion_user ?? {}
  for (const [id, record] of Object.entries(userMap)) {
    if (record.value?.name) {
      lookup[id] = record.value.name
    }
  }
  return lookup
}
