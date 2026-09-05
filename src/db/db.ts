import { openDB, type IDBPDatabase } from 'idb'

const DB_NAME = 'calvet'
const DB_VERSION = 2

let dbPromise: Promise<IDBPDatabase> | null = null

/** Single shared IndexedDB connection for every local store in the app
 * (contacts, mirrored calendar events). Keeping one `openDB` call avoids
 * version-conflict errors between modules that would otherwise each try
 * to own the database's upgrade lifecycle. */
export function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const contacts = db.createObjectStore('contacts', { keyPath: 'id' })
          contacts.createIndex('name', 'name')
        }
        if (oldVersion < 2) {
          const events = db.createObjectStore('events', { keyPath: 'localId' })
          events.createIndex('googleId', 'googleId')
          events.createIndex('syncStatus', 'syncStatus')
        }
      },
    })
  }
  return dbPromise
}
