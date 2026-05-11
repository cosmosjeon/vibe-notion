import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

describe('WorkspaceCommand', () => {
  beforeEach(() => {
    mock.restore()
  })

  afterEach(() => {
    mock.restore()
  })

  test('workspace list returns workspaces from getSpaces response', async () => {
    const mockInternalRequest = mock(async (_tokenV2: string, endpoint: string) => {
      if (endpoint === 'getSpaces') {
        return {
          'user-1': {
            space: {
              'space-1': {
                value: {
                  value: { id: 'space-1', name: 'Personal', icon: '🏠', plan_type: 'personal' },
                  role: 'editor',
                },
              },
              'space-2': {
                value: {
                  value: { id: 'space-2', name: 'Work', icon: '💼', plan_type: 'team' },
                  role: 'editor',
                },
              },
            },
          },
        }
      }
    })

    const mockGetCredentials = mock(async () => ({
      token_v2: 'test-token',
    }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(['list'], { from: 'user' })
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(2)
    expect(result[0].id).toBe('space-1')
    expect(result[0].name).toBe('Personal')
    expect(result[0].icon).toBe('🏠')
    expect(result[0].plan_type).toBe('personal')
    expect(result[0].role).toBe('member')
    expect(result[1].id).toBe('space-2')
    expect(result[1].name).toBe('Work')
    expect(result[1].role).toBe('member')
  })

  test('workspace list deduplicates spaces across multiple users', async () => {
    const mockInternalRequest = mock(async (_tokenV2: string, endpoint: string) => {
      if (endpoint === 'getSpaces') {
        return {
          'user-1': {
            space: {
              'space-1': {
                value: { value: { id: 'space-1', name: 'Shared Workspace' }, role: 'editor' },
              },
            },
          },
          'user-2': {
            space: {
              'space-1': {
                value: { value: { id: 'space-1', name: 'Shared Workspace' }, role: 'editor' },
              },
            },
          },
        }
      }
    })

    const mockGetCredentials = mock(async () => ({
      token_v2: 'test-token',
    }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(['list'], { from: 'user' })
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(result.length).toBe(1)
    expect(result[0].id).toBe('space-1')
    expect(result[0].name).toBe('Shared Workspace')
  })

  test('workspace list returns empty array when no spaces', async () => {
    const mockInternalRequest = mock(async (_tokenV2: string, endpoint: string) => {
      if (endpoint === 'getSpaces') {
        return {
          'user-1': {},
        }
      }
    })

    const mockGetCredentials = mock(async () => ({
      token_v2: 'test-token',
    }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(['list'], { from: 'user' })
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })

  test('workspace list includes guest workspaces from space_view_pointers', async () => {
    const mockInternalRequest = mock(async (_tokenV2: string, endpoint: string) => {
      if (endpoint === 'getSpaces') {
        return {
          'user-1': {
            space: {
              'space-1': {
                value: { value: { id: 'space-1', name: 'My Workspace' }, role: 'editor' },
              },
            },
            user_root: {
              'user-1': {
                value: {
                  value: {
                    space_view_pointers: [{ id: 'view-2', table: 'space_view', spaceId: 'space-2' }],
                  },
                  role: 'editor',
                },
              },
            },
          },
        }
      }
    })

    const mockGetCredentials = mock(async () => ({
      token_v2: 'test-token',
    }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(['list'], { from: 'user' })
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(2)
    const member = result.find((w: { id: string }) => w.id === 'space-1')
    const guest = result.find((w: { id: string }) => w.id === 'space-2')
    expect(member).toBeDefined()
    expect(member.role).toBe('member')
    expect(guest).toBeDefined()
    expect(guest.role).toBe('guest')
    expect(guest.id).toBe('space-2')
  })

  test('workspace list merges workspaces from stored accounts', async () => {
    const mockInternalRequest = mock(async (tokenV2: string, endpoint: string) => {
      if (endpoint !== 'getSpaces') return undefined

      if (tokenV2 === 'primary-token') {
        return {
          'user-1': {
            space: {
              'space-1': {
                value: { value: { id: 'space-1', name: 'indent', plan_type: 'team' }, role: 'editor' },
              },
            },
          },
        }
      }

      if (tokenV2 === 'secondary-token') {
        return {
          'user-2': {
            space: {
              'space-2': {
                value: { value: { id: 'space-2', name: 'Suyeol', plan_type: 'personal' }, role: 'editor' },
              },
            },
          },
        }
      }
    })

    const mockGetCredentials = mock(async () => ({
      token_v2: 'primary-token',
      accounts: [{ token_v2: 'primary-token' }, { token_v2: 'secondary-token' }],
    }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(['list'], { from: 'user' })
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(result.length).toBe(2)
    expect(result[0].name).toBe('indent')
    expect(result[1].name).toBe('Suyeol')
  })

  test('workspace list still returns other accounts when one stored token fails', async () => {
    const mockInternalRequest = mock(async (tokenV2: string, endpoint: string) => {
      if (endpoint !== 'getSpaces') return undefined

      if (tokenV2 === 'primary-token') {
        throw new Error('primary failed')
      }

      return {
        'user-2': {
          space: {
            'space-2': {
              value: { value: { id: 'space-2', name: 'Suyeol' }, role: 'editor' },
            },
          },
        },
      }
    })

    const mockGetCredentials = mock(async () => ({
      token_v2: 'primary-token',
      accounts: [{ token_v2: 'secondary-token' }],
    }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(['list'], { from: 'user' })
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(result.length).toBe(1)
    expect(result[0].name).toBe('Suyeol')
  })

  test('workspace resolve returns workspace id and name for a page', async () => {
    const mockInternalRequest = mock(async (_tokenV2: string, endpoint: string, body: unknown) => {
      if (endpoint === 'syncRecordValues') {
        const requests = (body as { requests: { pointer: { id: string } }[] }).requests
        const blockId = requests[0].pointer.id
        return {
          recordMap: {
            block: {
              [blockId]: {
                value: { value: { id: blockId, type: 'page', space_id: 'space-1' }, role: 'editor' },
              },
            },
          },
        }
      }
      if (endpoint === 'getSpaces') {
        return {
          'user-1': {
            space: {
              'space-1': {
                value: { value: { id: 'space-1', name: 'Acme' }, role: 'editor' },
              },
            },
          },
        }
      }
    })

    const mockGetCredentials = mock(async () => ({ token_v2: 'primary-token' }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(['resolve', '12345678-1234-1234-1234-123456789012'], { from: 'user' })
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(result.page_id).toBe('12345678-1234-1234-1234-123456789012')
    expect(result.workspace_id).toBe('space-1')
    expect(result.workspace_name).toBe('Acme')
  })

  test('workspace resolve probes additional accounts when the first fails', async () => {
    const mockInternalRequest = mock(async (tokenV2: string, endpoint: string, body: unknown) => {
      if (endpoint === 'syncRecordValues') {
        if (tokenV2 === 'primary-token') {
          throw new Error('forbidden')
        }
        const requests = (body as { requests: { pointer: { id: string } }[] }).requests
        const blockId = requests[0].pointer.id
        return {
          recordMap: {
            block: {
              [blockId]: { value: { id: blockId, type: 'page', space_id: 'space-2' } },
            },
          },
        }
      }
      if (endpoint === 'getSpaces') {
        return {}
      }
    })

    const mockGetCredentials = mock(async () => ({
      token_v2: 'primary-token',
      accounts: [{ token_v2: 'primary-token' }, { token_v2: 'secondary-token' }],
    }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(['resolve', '12345678-1234-1234-1234-123456789012'], { from: 'user' })
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(result.workspace_id).toBe('space-2')
  })

  test('workspace resolve fails when no account can see the page', async () => {
    const mockInternalRequest = mock(async () => {
      throw new Error('forbidden')
    })

    const mockGetCredentials = mock(async () => ({ token_v2: 'primary-token' }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const errorOutput: string[] = []
    const originalError = console.error
    console.error = (msg: string) => errorOutput.push(msg)

    let exitCode: number | undefined
    const originalExit = process.exit
    process.exit = ((code: number) => {
      exitCode = code
    }) as never

    try {
      await workspaceCommand.parseAsync(['resolve', '12345678-1234-1234-1234-123456789012'], { from: 'user' })
    } catch {
      // Expected
    }

    console.error = originalError
    process.exit = originalExit

    expect(errorOutput.length).toBeGreaterThan(0)
    const errorMsg = JSON.parse(errorOutput[0])
    expect(errorMsg.error).toContain('Could not resolve workspace')
    expect(exitCode).toBe(1)
  })

  test('workspace resolve accepts a full Notion URL', async () => {
    const seenIds: string[] = []
    const mockInternalRequest = mock(async (_tokenV2: string, endpoint: string, body: unknown) => {
      if (endpoint === 'syncRecordValues') {
        const requests = (body as { requests: { pointer: { id: string } }[] }).requests
        seenIds.push(requests[0].pointer.id)
        const blockId = requests[0].pointer.id
        return {
          recordMap: {
            block: {
              [blockId]: { value: { id: blockId, type: 'page', space_id: 'space-from-url' } },
            },
          },
        }
      }
      if (endpoint === 'getSpaces') return {}
    })

    const mockGetCredentials = mock(async () => ({ token_v2: 'primary-token' }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(
        ['resolve', 'https://www.notion.so/devxoul/My-Page-12345678123412341234123456789012?source=copy_link'],
        { from: 'user' },
      )
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(seenIds[0]).toBe('12345678-1234-1234-1234-123456789012')
    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(result.page_id).toBe('12345678-1234-1234-1234-123456789012')
    expect(result.workspace_id).toBe('space-from-url')
  })

  test('workspace resolve probes the collection table for database IDs', async () => {
    const mockInternalRequest = mock(async (_tokenV2: string, endpoint: string, body: unknown) => {
      if (endpoint === 'syncRecordValues') {
        const requests = (body as { requests: { pointer: { id: string; table: string } }[] }).requests
        const tables = requests.map((r) => r.pointer.table)
        expect(tables).toContain('block')
        expect(tables).toContain('collection')
        expect(tables).toContain('collection_view')
        return {
          recordMap: {
            collection: {
              [requests[0].pointer.id]: { value: { id: requests[0].pointer.id, space_id: 'space-db' } },
            },
          },
        }
      }
      if (endpoint === 'getSpaces') return {}
    })

    const mockGetCredentials = mock(async () => ({ token_v2: 'primary-token' }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(['resolve', '12345678-1234-1234-1234-123456789012'], { from: 'user' })
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(result.workspace_id).toBe('space-db')
  })

  test('workspace resolve includes the last underlying error when nothing resolves', async () => {
    const mockInternalRequest = mock(async () => {
      throw new Error('Notion internal API error: 401: token expired')
    })

    const mockGetCredentials = mock(async () => ({ token_v2: 'primary-token' }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const errorOutput: string[] = []
    const originalError = console.error
    console.error = (msg: string) => errorOutput.push(msg)

    let exitCode: number | undefined
    const originalExit = process.exit
    process.exit = ((code: number) => {
      exitCode = code
    }) as never

    try {
      await workspaceCommand.parseAsync(['resolve', '12345678-1234-1234-1234-123456789012'], { from: 'user' })
    } catch {
      // Expected
    }

    console.error = originalError
    process.exit = originalExit

    expect(errorOutput.length).toBeGreaterThan(0)
    const errorMsg = JSON.parse(errorOutput[0])
    expect(errorMsg.error).toContain('Last error: Notion internal API error: 401: token expired')
    expect(exitCode).toBe(1)
  })

  test('workspace resolve ignores unrelated records returned in the same response', async () => {
    const mockInternalRequest = mock(async (_tokenV2: string, endpoint: string, body: unknown) => {
      if (endpoint === 'syncRecordValues') {
        const requests = (body as { requests: { pointer: { id: string } }[] }).requests
        const requestedId = requests[0].pointer.id
        return {
          recordMap: {
            block: {
              'unrelated-block-id': { value: { id: 'unrelated-block-id', space_id: 'wrong-space' } },
              [requestedId]: { value: { id: requestedId, space_id: 'right-space' } },
            },
          },
        }
      }
      if (endpoint === 'getSpaces') return {}
    })

    const mockGetCredentials = mock(async () => ({ token_v2: 'primary-token' }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const output: string[] = []
    const originalLog = console.log
    console.log = (msg: string) => output.push(msg)

    try {
      await workspaceCommand.parseAsync(['resolve', '12345678-1234-1234-1234-123456789012'], { from: 'user' })
    } catch {
      // Expected to exit
    }

    console.log = originalLog

    expect(output.length).toBeGreaterThan(0)
    const result = JSON.parse(output[0])
    expect(result.workspace_id).toBe('right-space')
  })

  test('workspace list handles errors', async () => {
    const mockInternalRequest = mock(async () => {
      throw new Error('API error')
    })

    const mockGetCredentials = mock(async () => ({
      token_v2: 'test-token',
    }))

    mock.module('../client', () => ({
      internalRequest: mockInternalRequest,
      setActiveUserId: mock(),
      getActiveUserId: mock(),
    }))

    mock.module('./helpers', () => ({
      getCredentialsOrExit: mockGetCredentials,
      generateId: mock(() => 'mock-uuid'),
      resolveSpaceId: mock(async () => 'space-mock'),
      resolveCollectionViewId: mock(async () => 'view-mock'),
      resolveAndSetActiveUserId: mock(async () => {}),
      resolveBacklinkUsers: mock(async () => ({})),
      resolveDefaultTeamId: mock(async () => undefined),
    }))

    const { workspaceCommand } = await import('./workspace')
    const errorOutput: string[] = []
    const originalError = console.error
    console.error = (msg: string) => errorOutput.push(msg)

    let exitCode: number | undefined
    const originalExit = process.exit
    process.exit = ((code: number) => {
      exitCode = code
    }) as any

    try {
      await workspaceCommand.parseAsync(['list'], { from: 'user' })
    } catch {
      // Expected
    }

    console.error = originalError
    process.exit = originalExit

    expect(errorOutput.length).toBeGreaterThan(0)
    const errorMsg = JSON.parse(errorOutput[0])
    expect(errorMsg.error).toBe('API error')
    expect(exitCode).toBe(1)
  })
})
