import { spawn } from 'node:child_process';
import type {
  GitHubPort,
  ViewerInfo,
  RemoteSnapshotData,
  RemoteRepoInfo,
  RemoteListInfo,
  ReadmeDetails
} from '../core/ports.js';
import { DomainError } from '../core/errors.js';

export interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GhExecutor = (
  args: string[],
  stdin?: string,
  options?: { timeoutMs?: number; hostname?: string }
) => Promise<GhExecResult>;

export const defaultGhExecutor: GhExecutor = (args, stdin, options) => {
  return new Promise((resolve, reject) => {
    const timeoutMs = options?.timeoutMs ?? 45000;
    const finalArgs = [...args];
    if (options?.hostname && options.hostname !== 'github.com' && !finalArgs.includes('--hostname')) {
      finalArgs.unshift('--hostname', options.hostname);
    }

    const proc = spawn('gh', finalArgs, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      reject(
        new DomainError({
          code: 'NETWORK_ERROR',
          message: `gh command timed out after ${timeoutMs}ms: gh ${args[0]}`,
          retryable: true
        })
      );
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!timedOut) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new DomainError({
              code: 'DEPENDENCY_MISSING',
              message: 'gh CLI is not installed or not found in PATH'
            })
          );
        } else {
          reject(
            new DomainError({
              code: 'INTERNAL_ERROR',
              message: `Failed to spawn gh: ${err.message}`,
              cause: err
            })
          );
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!timedOut) {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0
        });
      }
    });

    if (stdin !== undefined) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
};

export function parseGhError(stderr: string, stdout?: string): DomainError {
  const combined = `${stderr}\n${stdout ?? ''}`.toLowerCase();

  if (
    combined.includes('could not resolve host') ||
    combined.includes('network is down') ||
    combined.includes('connection refused') ||
    combined.includes('etimedout') ||
    combined.includes('tls handshake')
  ) {
    return new DomainError({
      code: 'NETWORK_ERROR',
      message: `Network error connecting to GitHub: ${stderr.trim()}`,
      retryable: true
    });
  }

  if (
    combined.includes('authentication token') ||
    combined.includes('not logged into') ||
    combined.includes('http 401') ||
    combined.includes('bad credentials')
  ) {
    return new DomainError({
      code: 'AUTH_FAILED',
      message: `GitHub authentication failed: ${stderr.trim()}`
    });
  }

  if (combined.includes('rate limit') || combined.includes('http 429') || combined.includes('secondary rate limit')) {
    return new DomainError({
      code: 'RATE_LIMIT_EXCEEDED',
      message: `GitHub API rate limit exceeded: ${stderr.trim()}`,
      retryable: true
    });
  }

  if (
    combined.includes('resource not accessible') ||
    combined.includes('http 403') ||
    combined.includes('missing scope') ||
    combined.includes('forbidden')
  ) {
    return new DomainError({
      code: 'PERMISSION_DENIED',
      message: `GitHub permission denied: ${stderr.trim()}`
    });
  }

  return new DomainError({
    code: 'OPERATION_FAILED',
    message: `gh command failed: ${stderr.trim()}`
  });
}

export class GitHubGhAdapter implements GitHubPort {
  private readonly executor: GhExecutor;
  private readonly hostname: string;

  constructor(options?: { executor?: GhExecutor; hostname?: string }) {
    this.executor = options?.executor ?? defaultGhExecutor;
    this.hostname = options?.hostname ?? 'github.com';
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify({ query, variables: variables ?? {} });
    const res = await this.executor(['api', 'graphql', '--input', '-'], payload, {
      hostname: this.hostname
    });

    if (res.exitCode !== 0) {
      throw parseGhError(res.stderr, res.stdout);
    }

    let parsed: { data?: T; errors?: Array<{ message: string; type?: string }> };
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      throw new DomainError({
        code: 'INTERNAL_ERROR',
        message: `Failed to parse GraphQL response: ${res.stdout}`,
        cause: err
      });
    }

    if (parsed.errors && parsed.errors.length > 0) {
      const first = parsed.errors[0];
      const errMsg = parsed.errors.map((e) => e.message).join('; ');
      if (first.type === 'NOT_FOUND') {
        throw new DomainError({ code: 'OPERATION_FAILED', message: `Not found: ${errMsg}` });
      }
      if (first.type === 'FORBIDDEN') {
        throw new DomainError({ code: 'PERMISSION_DENIED', message: `Forbidden: ${errMsg}` });
      }
      if (first.type === 'RATE_LIMITED') {
        throw new DomainError({ code: 'RATE_LIMIT_EXCEEDED', message: `Rate limited: ${errMsg}`, retryable: true });
      }
      throw new DomainError({ code: 'OPERATION_FAILED', message: `GraphQL error: ${errMsg}` });
    }

    if (!parsed.data) {
      throw new DomainError({ code: 'INTERNAL_ERROR', message: 'Missing data in GraphQL response' });
    }

    return parsed.data;
  }

  private async rest<T>(endpoint: string, options?: { method?: string; body?: unknown }): Promise<T> {
    const args = ['api', endpoint];
    let stdin: string | undefined;

    if (options?.method && options.method !== 'GET') {
      args.push('--method', options.method);
    }

    if (options?.body) {
      args.push('--input', '-');
      stdin = JSON.stringify(options.body);
    }

    const res = await this.executor(args, stdin, { hostname: this.hostname });

    if (res.exitCode !== 0) {
      throw parseGhError(res.stderr, res.stdout);
    }

    try {
      return JSON.parse(res.stdout) as T;
    } catch (err) {
      throw new DomainError({
        code: 'INTERNAL_ERROR',
        message: `Failed to parse REST JSON: ${res.stdout}`,
        cause: err
      });
    }
  }

  async getViewer(): Promise<ViewerInfo> {
    const query = `
      query GetViewer {
        viewer {
          id
          login
        }
      }
    `;
    const data = await this.graphql<{ viewer: { id: string; login: string } }>(query);
    return {
      hostname: this.hostname,
      viewerId: data.viewer.id,
      login: data.viewer.login
    };
  }

  async readSnapshot(): Promise<RemoteSnapshotData> {
    const viewer = await this.getViewer();

    // 1. Fetch all starred repositories
    const repositories: RemoteRepoInfo[] = [];
    let starCursor: string | null = null;
    let hasMoreStars = true;

    try {
      while (hasMoreStars) {
        const query = `
          query FetchStarred($cursor: String) {
            viewer {
              starredRepositories(first: 100, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  name
                  description
                  primaryLanguage {
                    name
                  }
                  owner {
                    login
                  }
                }
              }
            }
          }
        `;
        const res: {
          viewer: {
            starredRepositories: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<{
                id: string;
                name: string;
                description: string | null;
                primaryLanguage: { name: string } | null;
                owner: { login: string };
              }>;
            };
          };
        } = await this.graphql(query, { cursor: starCursor });

        const starred = res.viewer.starredRepositories;
        for (const node of starred.nodes) {
          repositories.push({
            id: node.id,
            owner: node.owner.login,
            name: node.name,
            description: node.description ?? null,
            primaryLanguage: node.primaryLanguage?.name ?? null,
            isStarred: true
          });
        }

        hasMoreStars = starred.pageInfo.hasNextPage;
        starCursor = starred.pageInfo.endCursor;
      }
    } catch (err) {
      throw new DomainError({
        code: 'NETWORK_ERROR',
        message: `Failed to complete fetching starred repositories: ${err instanceof Error ? err.message : String(err)}`,
        cause: err
      });
    }

    // 2. Fetch all user lists with repository IDs
    const lists: RemoteListInfo[] = [];
    const knownRepoIds = new Set(repositories.map((r) => r.id));
    const extraReposToFetch = new Map<string, { id: string; name: string; owner: string }>();

    let listCursor: string | null = null;
    let hasMoreLists = true;

    try {
      while (hasMoreLists) {
        const query = `
          query FetchUserLists($cursor: String) {
            viewer {
              lists(first: 30, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  name
                  description
                  isPrivate
                  items(first: 100) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    nodes {
                      __typename
                      ... on Repository {
                        id
                        name
                        owner {
                          login
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `;

        const res: {
          viewer: {
            lists: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<{
                id: string;
                name: string;
                description: string | null;
                isPrivate: boolean;
                items: {
                  pageInfo: { hasNextPage: boolean; endCursor: string | null };
                  nodes: Array<{
                    __typename: string;
                    id?: string;
                    name?: string;
                    owner?: { login: string };
                  }>;
                };
              }>;
            };
          };
        } = await this.graphql(query, { cursor: listCursor });

        for (const listNode of res.viewer.lists.nodes) {
          const listRepoIds: string[] = [];
          let unsupportedCount = 0;

          // Process first page of items
          for (const item of listNode.items.nodes) {
            if (item.__typename === 'Repository' && item.id) {
              listRepoIds.push(item.id);
              if (!knownRepoIds.has(item.id) && item.name && item.owner) {
                extraReposToFetch.set(item.id, {
                  id: item.id,
                  name: item.name,
                  owner: item.owner.login
                });
              }
            } else {
              unsupportedCount++;
            }
          }

          // If list has more than 100 items, paginate items for this list
          let itemCursor = listNode.items.pageInfo.endCursor;
          let hasMoreItems = listNode.items.pageInfo.hasNextPage;

          while (hasMoreItems) {
            const itemsQuery = `
              query FetchListItems($listId: ID!, $cursor: String) {
                node(id: $listId) {
                  ... on UserList {
                    items(first: 100, after: $cursor) {
                      pageInfo {
                        hasNextPage
                        endCursor
                      }
                      nodes {
                        __typename
                        ... on Repository {
                          id
                          name
                          owner {
                            login
                          }
                        }
                      }
                    }
                  }
                }
              }
            `;

            const itemRes: {
              node: {
                items: {
                  pageInfo: { hasNextPage: boolean; endCursor: string | null };
                  nodes: Array<{
                    __typename: string;
                    id?: string;
                    name?: string;
                    owner?: { login: string };
                  }>;
                };
              };
            } = await this.graphql(itemsQuery, { listId: listNode.id, cursor: itemCursor });

            for (const item of itemRes.node.items.nodes) {
              if (item.__typename === 'Repository' && item.id) {
                listRepoIds.push(item.id);
                if (!knownRepoIds.has(item.id) && item.name && item.owner) {
                  extraReposToFetch.set(item.id, {
                    id: item.id,
                    name: item.name,
                    owner: item.owner.login
                  });
                }
              } else {
                unsupportedCount++;
              }
            }

            hasMoreItems = itemRes.node.items.pageInfo.hasNextPage;
            itemCursor = itemRes.node.items.pageInfo.endCursor;
          }

          lists.push({
            id: listNode.id,
            name: listNode.name,
            description: listNode.description ?? null,
            isPrivate: listNode.isPrivate,
            repositoryIds: listRepoIds,
            unsupportedItemCount: unsupportedCount
          });
        }

        hasMoreLists = res.viewer.lists.pageInfo.hasNextPage;
        listCursor = res.viewer.lists.pageInfo.endCursor;
      }
    } catch (err) {
      throw new DomainError({
        code: 'NETWORK_ERROR',
        message: `Failed to complete fetching user lists: ${err instanceof Error ? err.message : String(err)}`,
        cause: err
      });
    }

    // Add extra repos found in lists that were not starred
    for (const extra of extraReposToFetch.values()) {
      repositories.push({
        id: extra.id,
        owner: extra.owner,
        name: extra.name,
        description: null,
        primaryLanguage: null,
        isStarred: false
      });
    }

    return {
      account: viewer,
      coverage: {
        starsComplete: true,
        listsComplete: true,
        membershipsComplete: true,
        error: null
      },
      repositories,
      lists
    };
  }

  async readReadme(owner: string, repo: string): Promise<ReadmeDetails> {
    const endpoint = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`;
    try {
      const data = await this.rest<{
        content: string;
        encoding: string;
        sha: string;
        size: number;
        name: string;
      }>(endpoint);

      const raw = Buffer.from(data.content, 'base64').toString('utf8');
      const maxLen = 30000;
      const truncated = raw.length > maxLen;
      const content = truncated ? raw.slice(0, maxLen) : raw;

      return {
        content,
        sha: data.sha,
        truncated,
        byteLength: raw.length,
        source: data.name
      };
    } catch (err) {
      if (err instanceof DomainError && err.code === 'OPERATION_FAILED') {
        return {
          content: '',
          sha: '',
          truncated: false,
          byteLength: 0,
          source: 'none'
        };
      }
      throw err;
    }
  }

  async createList(input: {
    name: string;
    description?: string | null;
    isPrivate: boolean;
  }): Promise<{ id: string; name: string; isPrivate: boolean }> {
    const mutation = `
      mutation CreateList($name: String!, $description: String, $isPrivate: Boolean!) {
        createUserList(input: {
          name: $name,
          description: $description,
          isPrivate: $isPrivate
        }) {
          list {
            id
            name
            isPrivate
          }
        }
      }
    `;

    const res = await this.graphql<{
      createUserList: { list: { id: string; name: string; isPrivate: boolean } };
    }>(mutation, {
      name: input.name,
      description: input.description ?? null,
      isPrivate: input.isPrivate
    });

    return res.createUserList.list;
  }

  async updateList(input: {
    listId: string;
    changes: { name?: string; description?: string | null; isPrivate?: boolean };
  }): Promise<{ id: string }> {
    const mutation = `
      mutation UpdateList($input: UpdateUserListInput!) {
        updateUserList(input: $input) {
          list {
            id
          }
        }
      }
    `;

    const payload: Record<string, unknown> = {
      listId: input.listId
    };
    if (input.changes.name !== undefined) {
      payload.name = input.changes.name;
    }
    if ('description' in input.changes) {
      payload.description = input.changes.description;
    }
    if (input.changes.isPrivate !== undefined) {
      payload.isPrivate = input.changes.isPrivate;
    }

    const res = await this.graphql<{ updateUserList: { list: { id: string } } }>(mutation, {
      input: payload
    });

    return res.updateUserList.list;
  }

  async deleteList(input: { listId: string }): Promise<void> {
    const mutation = `
      mutation DeleteList($listId: ID!) {
        deleteUserList(input: { listId: $listId }) {
          user {
            login
          }
        }
      }
    `;

    await this.graphql(mutation, { listId: input.listId });
  }

  async setMemberships(input: {
    repositoryId: string;
    listIds: string[];
  }): Promise<{ repositoryId: string; listIds: string[] }> {
    const mutation = `
      mutation SetMemberships($itemId: ID!, $listIds: [ID!]!) {
        updateUserListsForItem(input: {
          itemId: $itemId,
          listIds: $listIds
        }) {
          lists {
            id
          }
        }
      }
    `;

    const res = await this.graphql<{
      updateUserListsForItem: { lists: Array<{ id: string }> };
    }>(mutation, {
      itemId: input.repositoryId,
      listIds: input.listIds
    });

    const updatedListIds = res.updateUserListsForItem.lists.map((l) => l.id);

    return {
      repositoryId: input.repositoryId,
      listIds: updatedListIds
    };
  }

  async getList(listId: string): Promise<RemoteListInfo | null> {
    const repoIds: string[] = [];
    let unsupported = 0;
    let listInfo: { id: string; name: string; description: string | null; isPrivate: boolean } | null = null;
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const query = `
        query GetList($listId: ID!, $cursor: String) {
          node(id: $listId) {
            ... on UserList {
              id
              name
              description
              isPrivate
              items(first: 100, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  __typename
                  ... on Repository {
                    id
                  }
                }
              }
            }
          }
        }
      `;

      const res: {
        node: {
          id: string;
          name: string;
          description: string | null;
          isPrivate: boolean;
          items: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ __typename: string; id?: string }>;
          };
        } | null;
      } = await this.graphql(query, { listId, cursor });

      if (!res.node) return null;

      if (!listInfo) {
        listInfo = {
          id: res.node.id,
          name: res.node.name,
          description: res.node.description ?? null,
          isPrivate: res.node.isPrivate
        };
      }

      for (const item of res.node.items.nodes) {
        if (item.__typename === 'Repository' && item.id) {
          repoIds.push(item.id);
        } else {
          unsupported++;
        }
      }

      hasMore = res.node.items.pageInfo.hasNextPage;
      cursor = res.node.items.pageInfo.endCursor;
    }

    if (!listInfo) return null;

    return {
      id: listInfo.id,
      name: listInfo.name,
      description: listInfo.description,
      isPrivate: listInfo.isPrivate,
      repositoryIds: repoIds,
      unsupportedItemCount: unsupported
    };
  }

  async readLists(): Promise<RemoteListInfo[]> {
    const lists: RemoteListInfo[] = [];
    let listCursor: string | null = null;
    let hasMoreLists = true;

    while (hasMoreLists) {
      const query = `
        query FetchViewerListsWithItems($cursor: String) {
          viewer {
            lists(first: 100, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                name
                description
                isPrivate
                items(first: 100) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    __typename
                    ... on Repository {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const res: {
        viewer: {
          lists: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              id: string;
              name: string;
              description: string | null;
              isPrivate: boolean;
              items: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: Array<{ __typename: string; id?: string }>;
              };
            }>;
          };
        };
      } = await this.graphql(query, { cursor: listCursor });

      for (const listNode of res.viewer.lists.nodes) {
        const repositoryIds: string[] = [];
        let unsupportedItemCount = 0;
        for (const item of listNode.items.nodes) {
          if (item.__typename === 'Repository' && item.id) {
            repositoryIds.push(item.id);
          } else {
            unsupportedItemCount++;
          }
        }

        let itemCursor = listNode.items.pageInfo.endCursor;
        let hasMoreItems = listNode.items.pageInfo.hasNextPage;
        while (hasMoreItems) {
          const itemsQuery = `
            query FetchListItemsOnly($listId: ID!, $cursor: String) {
              node(id: $listId) {
                ... on UserList {
                  items(first: 100, after: $cursor) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    nodes {
                      __typename
                      ... on Repository {
                        id
                      }
                    }
                  }
                }
              }
            }
          `;
          const itemRes: {
            node: {
              items: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: Array<{ __typename: string; id?: string }>;
              };
            } | null;
          } = await this.graphql(itemsQuery, { listId: listNode.id, cursor: itemCursor });

          if (itemRes.node?.items?.nodes) {
            for (const item of itemRes.node.items.nodes) {
              if (item.__typename === 'Repository' && item.id) {
                repositoryIds.push(item.id);
              } else {
                unsupportedItemCount++;
              }
            }
          }

          hasMoreItems = itemRes.node?.items?.pageInfo?.hasNextPage ?? false;
          itemCursor = itemRes.node?.items?.pageInfo?.endCursor ?? null;
        }

        lists.push({
          id: listNode.id,
          name: listNode.name,
          description: listNode.description ?? null,
          isPrivate: listNode.isPrivate,
          repositoryIds,
          unsupportedItemCount
        });
      }

      hasMoreLists = res.viewer.lists.pageInfo.hasNextPage;
      listCursor = res.viewer.lists.pageInfo.endCursor;
    }

    return lists;
  }
}
