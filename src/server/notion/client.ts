/**
 * Minimal Notion API client -- only what the one-way sync needs.
 *
 * Deliberately narrow. The sync writes four properties and reads a handful;
 * everything else in the tracker belongs to the user and this client has no
 * way to touch it even by accident, because no code path here builds a
 * property payload for Author, Rating, Description or Link.
 */

const API = 'https://api.notion.com/v1'
const VERSION = '2022-06-28'

export interface NotionConfig {
  token: string
  databaseId: string
}

export function notionConfig(): NotionConfig | null {
  const token = process.env.NOTION_TOKEN
  const databaseId = process.env.NOTION_DATABASE_ID
  if (!token || !databaseId) return null
  return { token, databaseId }
}

export class NotionError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'NotionError'
    this.status = status
  }
}

async function call<T>(cfg: NotionConfig, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Notion-Version': VERSION,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new NotionError(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 400)}`, res.status)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

/** A tracker row, reduced to the fields the sync reasons about. */
export interface NotionRow {
  id: string
  name: string
  type: string | null
  status: string | null
  url: string
  /** True when the row has any of the user's own prose/rating filled in. */
  hasUserContent: boolean
}

function readTitle(props: Record<string, any>): string {
  for (const v of Object.values(props)) {
    if (v?.type === 'title') {
      return (v.title ?? []).map((t: any) => t.plain_text ?? '').join('').trim()
    }
  }
  return ''
}

function readNamed(props: Record<string, any>, key: string): any {
  // Property names vary in case/spacing between databases.
  const found = Object.entries(props).find(
    ([k]) => k.toLowerCase().replace(/\s+/g, '') === key.toLowerCase().replace(/\s+/g, ''),
  )
  return found?.[1]
}

function readChoice(props: Record<string, any>, key: string): string | null {
  const p = readNamed(props, key)
  if (!p) return null
  if (p.type === 'status') return p.status?.name ?? null
  if (p.type === 'select') return p.select?.name ?? null
  if (p.type === 'multi_select') return (p.multi_select ?? [])[0]?.name ?? null
  return null
}

function toRow(page: any): NotionRow {
  const props = page.properties ?? {}
  const rich = (key: string) => {
    const p = readNamed(props, key)
    if (!p) return ''
    if (p.type === 'rich_text') return (p.rich_text ?? []).map((t: any) => t.plain_text).join('')
    if (p.type === 'url') return p.url ?? ''
    if (p.type === 'number') return p.number == null ? '' : String(p.number)
    return ''
  }
  return {
    id: page.id,
    name: readTitle(props),
    type: readChoice(props, 'Type'),
    status: readChoice(props, 'Status'),
    url: page.url ?? '',
    hasUserContent: Boolean(rich('Description') || rich('Rating') || rich('Author') || rich('Link')),
  }
}

/** Every row in the tracker database, following pagination. */
export async function listRows(cfg: NotionConfig): Promise<NotionRow[]> {
  const out: NotionRow[] = []
  let cursor: string | undefined
  do {
    const body: Record<string, unknown> = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    const page = await call<{ results: any[]; next_cursor: string | null; has_more: boolean }>(
      cfg,
      `/databases/${cfg.databaseId}/query`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    out.push(...page.results.map(toRow))
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
  } while (cursor)
  return out
}

/** Names of the property that actually holds the title, and the Status options. */
export async function describeDatabase(cfg: NotionConfig): Promise<{
  titleProp: string
  statusProp: string | null
  statusOptions: string[]
  typeProp: string | null
  completedProp: string | null
}> {
  const db = await call<any>(cfg, `/databases/${cfg.databaseId}`)
  const props: Record<string, any> = db.properties ?? {}
  let titleProp = 'Name'
  let statusProp: string | null = null
  let typeProp: string | null = null
  let completedProp: string | null = null
  let statusOptions: string[] = []

  for (const [name, p] of Object.entries(props)) {
    if (p.type === 'title') titleProp = name
    const norm = name.toLowerCase().replace(/\s+/g, '')
    if (norm === 'status') {
      statusProp = name
      statusOptions = (p.status?.options ?? p.select?.options ?? []).map((o: any) => o.name)
    }
    if (norm === 'type') typeProp = name
    if (norm === 'completeddate' || norm === 'completed') completedProp = name
  }
  return { titleProp, statusProp, statusOptions, typeProp, completedProp }
}

export interface WriteFields {
  /** Only set when creating; never sent for an existing row. */
  name?: string
  status?: string
  type?: string
  completedDate?: string | null
}

function buildProperties(
  schema: Awaited<ReturnType<typeof describeDatabase>>,
  f: WriteFields,
): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  if (f.name !== undefined) {
    props[schema.titleProp] = { title: [{ type: 'text', text: { content: f.name } }] }
  }
  if (f.status !== undefined && schema.statusProp) {
    props[schema.statusProp] = { status: { name: f.status } }
  }
  if (f.type !== undefined && schema.typeProp) {
    props[schema.typeProp] = { select: { name: f.type } }
  }
  if (f.completedDate !== undefined && schema.completedProp) {
    props[schema.completedProp] =
      f.completedDate === null ? { date: null } : { date: { start: f.completedDate } }
  }
  return props
}

export async function createRow(
  cfg: NotionConfig,
  schema: Awaited<ReturnType<typeof describeDatabase>>,
  fields: WriteFields,
): Promise<NotionRow> {
  const page = await call<any>(cfg, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: cfg.databaseId },
      properties: buildProperties(schema, fields),
    }),
  })
  return toRow(page)
}

/**
 * Update an existing row.
 *
 * `name` is never accepted here: the user's own row titles must survive, and a
 * rename they make in Notion has to persist. Matching is by stored page id, so
 * a renamed row is still found without ever being rewritten.
 */
export async function updateRow(
  cfg: NotionConfig,
  schema: Awaited<ReturnType<typeof describeDatabase>>,
  pageId: string,
  fields: Omit<WriteFields, 'name'>,
): Promise<void> {
  await call(cfg, `/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: buildProperties(schema, fields) }),
  })
}
