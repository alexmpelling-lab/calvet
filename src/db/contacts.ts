import { getDb } from './db'

export interface Contact {
  id: string
  name: string
  email?: string
  notes?: string
  mentionCount: number
  lastMentioned: string
  /** Names that have already been flagged as a possible duplicate of this
   * contact and left unmerged — once the user has effectively said (by not
   * merging) "these are different people," the same pair shouldn't keep
   * getting re-asked about on every future mention. */
  dismissedDuplicateNames?: string[]
  /** Running estimate of how many minutes late this person tends to run,
   * inferred from how often meetings involving them get pushed later after
   * being scheduled — never from directly observed arrival data (this app
   * has none), just a pattern in reschedules. */
  avgLatenessMinutes?: number
  latenessSampleCount?: number
}

const STORE = 'contacts'

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

/** A flat edit-distance threshold of 2 misfires on short names — "Al"/"Ed"
 * or "Jon"/"Tom" are 2 edits apart and clearly different people, but the
 * same distance on longer names ("Kristen"/"Kirsten") really is a likely
 * typo of the same person. Scale the allowed distance with name length
 * instead of using one fixed number for every name. */
function isLikelyTypo(a: string, b: string): boolean {
  const shorterLength = Math.min(a.length, b.length)
  const distance = levenshtein(a, b)
  if (shorterLength < 5) return distance <= 1
  return distance <= 2
}

/** Returns existing contacts whose name is close enough to be a possible
 * duplicate, excluding any pair the user has already effectively dismissed
 * (mentioned again without merging) so the same ambiguity doesn't nag on
 * every future mention. */
export async function findPossibleDuplicates(name: string): Promise<Contact[]> {
  const all = await listContacts()
  const lower = name.trim().toLowerCase()
  return all.filter((c) => {
    if (c.name.toLowerCase() === lower) return false
    if (c.dismissedDuplicateNames?.includes(lower)) return false
    const firstNameOnly = lower.split(' ')[0]
    const otherFirstName = c.name.toLowerCase().split(' ')[0]
    if (firstNameOnly === otherFirstName) return true
    return isLikelyTypo(lower, c.name.toLowerCase())
  })
}

/** Marks a candidate as "already asked about, left unmerged" for this exact
 * name, so it stops being suggested as a duplicate for that name again. */
async function dismissDuplicate(candidateId: string, name: string): Promise<void> {
  const db = await getDb()
  const candidate: Contact | undefined = await db.get(STORE, candidateId)
  if (!candidate) return
  const lower = name.trim().toLowerCase()
  const dismissed = candidate.dismissedDuplicateNames ?? []
  if (dismissed.includes(lower)) return
  await db.put(STORE, { ...candidate, dismissedDuplicateNames: [...dismissed, lower] })
}

export async function listContacts(): Promise<Contact[]> {
  const db = await getDb()
  return db.getAll(STORE)
}

export async function getContactByName(name: string): Promise<Contact | undefined> {
  const all = await listContacts()
  return all.find((c) => c.name.toLowerCase() === name.trim().toLowerCase())
}

/** A first-name-only mention ("Jon") after someone was introduced with a
 * full name ("Jon Smith") is almost always the same person, not a new one —
 * without this, every later first-name-only mention fragments into its own
 * separate contact instead of building up one person's mention history. Only
 * consolidates when exactly one existing contact's name starts with the
 * mentioned name as a whole word, so a genuine ambiguity (two Jons) still
 * falls through to the normal duplicate-flagging path instead of guessing. */
async function findUnambiguousFirstNameMatch(name: string): Promise<Contact | undefined> {
  const trimmed = name.trim()
  if (trimmed.includes(' ')) return undefined // already a fuller name, nothing to consolidate onto
  const all = await listContacts()
  const lower = trimmed.toLowerCase()
  const matches = all.filter((c) => c.name.toLowerCase().split(' ')[0] === lower)
  return matches.length === 1 ? matches[0] : undefined
}

/** Records a mention of a person, creating or updating their contact entry. */
export async function recordMention(name: string, email?: string): Promise<Contact> {
  const db = await getDb()
  const existing = (await getContactByName(name)) ?? (await findUnambiguousFirstNameMatch(name))
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

  if (!existing) {
    // A brand new contact was created despite possible-duplicate candidates
    // existing (the caller already surfaced those via findPossibleDuplicates)
    // — mark them dismissed so this same overlap isn't re-flagged forever.
    const duplicates = await findPossibleDuplicates(name)
    await Promise.all(duplicates.map((d) => dismissDuplicate(d.id, name)))
  }

  return contact
}

const MAX_LATENESS_SAMPLE_MINUTES = 90
const MIN_LATENESS_SAMPLES_TO_MENTION = 2

/** Records one instance of a same-day reschedule pushing an event involving
 * this person later — a proxy for "ran late," since the app has no way to
 * observe actual arrival time. Ignores implausibly large pushes (more
 * likely a genuine reschedule to a different day/reason than lateness). */
export async function recordLatenessSample(name: string, deltaMinutes: number): Promise<void> {
  if (deltaMinutes <= 0 || deltaMinutes > MAX_LATENESS_SAMPLE_MINUTES) return
  const contact = await getContactByName(name)
  if (!contact) return
  const priorCount = contact.latenessSampleCount ?? 0
  const priorAvg = contact.avgLatenessMinutes ?? 0
  const newCount = priorCount + 1
  const newAvg = (priorAvg * priorCount + deltaMinutes) / newCount
  await updateContact(contact.id, { avgLatenessMinutes: Math.round(newAvg), latenessSampleCount: newCount })
}

/** Returns a padding suggestion in minutes if this person has a
 * well-established pattern of running late, or null if there's not enough
 * history to say anything — never guesses off one data point. */
export async function getLatenessPadding(name: string): Promise<number | null> {
  const contact = await getContactByName(name)
  if (!contact || (contact.latenessSampleCount ?? 0) < MIN_LATENESS_SAMPLES_TO_MENTION) return null
  return contact.avgLatenessMinutes ?? null
}

export async function updateContact(id: string, changes: Partial<Contact>): Promise<void> {
  const db = await getDb()
  const existing = await db.get(STORE, id)
  if (!existing) return
  await db.put(STORE, { ...existing, ...changes })
}

/** Finds which known contact, if any, is named in a piece of free text
 * (typically an event summary like "Coffee with Priya"). Used to connect an
 * event to a contact for lateness tracking without requiring the agent to
 * separately pass a structured attendee reference. */
export async function findMentionedContact(text: string): Promise<Contact | undefined> {
  const all = await listContacts()
  const lower = text.toLowerCase()
  return all.find((c) => {
    const firstName = c.name.toLowerCase().split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return firstName.length >= 3 && new RegExp(`\\b${firstName}\\b`).test(lower)
  })
}

export async function mergeContacts(keepId: string, mergeId: string): Promise<void> {
  const db = await getDb()
  const keep = await db.get(STORE, keepId)
  const merge = await db.get(STORE, mergeId)
  if (!keep || !merge) return
  await db.put(STORE, { ...keep, mentionCount: keep.mentionCount + merge.mentionCount })
  await db.delete(STORE, mergeId)
}
