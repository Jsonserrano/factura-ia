import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { abrirDB } from './db'
import { crearApp } from './app'

const PORT = Number(process.env.PORT ?? 3001)
// Turso en producción; archivo SQLite local en desarrollo
const DB_URL = process.env.TURSO_DATABASE_URL ?? `file:${process.env.DB_PATH ?? 'factura-ia.db'}`
const DB_TOKEN = process.env.TURSO_AUTH_TOKEN
const JWT_SECRET = process.env.JWT_SECRET
const ORIGENES = process.env.CORS_ORIGINS?.split(',').map((s) => s.trim())

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    console.error('JWT_SECRET es obligatorio (mínimo 32 caracteres) en producción')
    process.exit(1)
  }
  console.warn('⚠ Usando JWT_SECRET de desarrollo. Define JWT_SECRET en producción.')
}

const app = crearApp(await abrirDB(DB_URL, DB_TOKEN), {
  jwtSecret: JWT_SECRET ?? 'dev-secret-solo-para-desarrollo-local-0000',
  origenesCors: ORIGENES,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  limiteIA: Number(process.env.LIMITE_IA ?? 30),
  correo: {
    brevoKey: process.env.BREVO_API_KEY,
    remitente: process.env.BREVO_SENDER_EMAIL,
    limiteDiario: Number(process.env.LIMITE_CORREOS ?? 30),
    enviarFactura:
      !process.env.BREVO_API_KEY && process.env.NODE_ENV !== 'production'
        ? async (c) => console.log(`[correo simulado] ${c.para}: ${c.asunto} (${c.adjuntos.map((a) => a.nombre).join(', ')})`)
        : undefined,
  },
  emisorPredeterminado: {
    ...(process.env.EMISOR_NOMBRE ? { razonSocial: process.env.EMISOR_NOMBRE } : {}),
    ...(process.env.EMISOR_EMAIL ? { email: process.env.EMISOR_EMAIL } : {}),
  },
  contacto: {
    whatsapp: process.env.CONTACTO_WHATSAPP?.replace(/\D/g, ''),
    nombre: process.env.CONTACTO_NOMBRE,
    turnstileSecreto: process.env.TURNSTILE_SECRET,
    turnstileSitio: process.env.TURNSTILE_SITE_KEY,
  },
})

// En producción el mismo servidor entrega el frontend compilado (dist/)
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
app.use(express.static(dist))

app.listen(PORT, () =>
  console.log(`Factura·IA en http://localhost:${PORT} · BD: ${DB_URL.startsWith('libsql') ? 'Turso' : DB_URL} · IA: ${process.env.ANTHROPIC_API_KEY ? 'sí' : 'no'}`),
)
