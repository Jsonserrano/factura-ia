import { createClient, type Client } from '@libsql/client'

export type DB = Client

/**
 * Base de datos SQLite vía libSQL:
 *  - Local / pruebas: url "file:factura-ia.db" o ":memory:"
 *  - Producción: Turso (SQLite en la nube) con TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
 * Mismo SQL en los dos casos.
 */
export async function abrirDB(url: string, authToken?: string): Promise<DB> {
  const db = createClient({ url, authToken })
  await db.executeMultiple(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS usuarios (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      nombre        TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      creado_en     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS emisores (
      usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
      datos      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facturas (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      consecutivo  INTEGER NOT NULL,
      numero       TEXT NOT NULL,
      cufe         TEXT NOT NULL,
      estado       TEXT NOT NULL DEFAULT 'Pendiente' CHECK (estado IN ('Pendiente','Pagada','Anulada')),
      neto_pagar   REAL NOT NULL,
      datos        TEXT NOT NULL,
      creado_en    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (usuario_id, consecutivo),
      UNIQUE (usuario_id, numero)
    );
    CREATE INDEX IF NOT EXISTS idx_facturas_usuario ON facturas(usuario_id, consecutivo DESC);

  `)
  return db
}
