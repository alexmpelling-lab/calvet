import { openDB, type IDBPDatabase } from 'idb'

export interface Contact {
  id: string
  name: string
  email?: string
  notes?: string
  mentionCount: number
  lastMentioned: string
}

const DB_NAME = 'calvet'
const STORE = 'contacts'

let dbPromise: Promise<IDBPDatabase> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('name', 'name')
      },
    })
  }
  return dbPromise
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[a.length][b.length]
}

/** Returns existing contacts whose name is close enough to be a possible duplicate. */
export async function findPossibleDuplicates(name: string): Promise<Contact[]> {
  const all = await listContacts()
  const lower = name.trim().toLowerCase()
  return all.filter((c) => {
    if (c.name.toLowerCase() === lower) return false
    const firstNameOnly = lower.split(' ')[0]
    const otherFirstName = c.name.toLowerCase().split(' ')[0]
    if (firstNameOnly === otherFirstName) return true
    return levenshtein(lower, c.name.toLowerCase()) <= 2
  })
}

export async function listContacts(): Promise<Contact[]> {
  const db = await getDb()
  return db.getAll(STORE)
}

export async function getContactByName(name: string): Promise<Contact | undefined> {
  const all = await listContacts()
  return all.find((c) => c.name.toLowerCase() === name.trim().toLowerCase())
}

/** Records a mention of a person, creating or updating their contact entry. */
export async function recordMention(name: string, email?: string): Promise<Contact> {
  const db = await getDb()
  const existing = await getContactByName(name)
  const contact: Contact = existing
    ? { ...existing, email: email ?? existing.email, mentionCount: existing.mentionCount + 1, lastMentioned: new Date().toISOString() }
    : {
        id: crypto.randomUUID(),
        name: name.trim(),
        email,
        mentionCount: 1,
        lastMentioned: new Date().toISOString(),
      }
  await db.put(STORE, contact)
  return contact
}

export async function updateContact(id: string, changes: Partial<Contact>): Promise<void> {
  const db = await getDb()
  const existing = await db.get(STORE, id)
  if (!existing) return
  await db.put(STORE, { ...existing, ...changes })
}

export async function mergeContacts(keepId: string, mergeId: string): Promise<void> {
  const db = await getDb()
  const keep = await db.get(STORE, keepId)
  const merge = await db.get(STORE, mergeId)
  if (!keep || !merge) return
  await db.put(STORE, { ...keep, mentionCount: keep.mentionCount + merge.mentionCount })
  await db.delete(STORE, mergeId)
}
