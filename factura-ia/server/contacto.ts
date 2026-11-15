import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/* ============================================================
 * Botón "Escríbeme" directo a WhatsApp, solo para humanos.
 *
 * El número NO está en el código ni en la página: vive en una variable
 * de entorno del servidor y solo se entrega en el momento del clic si:
 *  1. Hay un reto firmado por el servidor (HMAC), reciente y de un solo uso
 *  2. El navegador resolvió una prueba de trabajo (SHA-256) → cuesta CPU a los bots
 *  3. Hubo interacción real (movimiento/toque) y un tiempo mínimo en la página
 *  4. No se superó el límite por IP ni el límite diario global
 *  5. (Opcional) Cloudflare Turnstile confirma que es una persona
 * Quien lea el HTML, el JavaScript o el repositorio nunca encuentra el número.
 * ============================================================ */

export interface Reto {
  reto: string
  emitido: number
  dificultad: number
  firma: string
}

const firmar = (secreto: string, r: Omit<Reto, 'firma'>) =>
  createHmac('sha256', secreto).update(`${r.reto}.${r.emitido}.${r.dificultad}`).digest('hex')

export function crearReto(secreto: string, dificultad: number, ahora = Date.now()): Reto {
  const base = { reto: randomBytes(16).toString('hex'), emitido: ahora, dificultad }
  return { ...base, firma: firmar(secreto, base) }
}

export function firmaValida(secreto: string, r: Reto): boolean {
  const esperada = Buffer.from(firmar(secreto, r))
  const recibida = Buffer.from(String(r.firma))
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida)
}

/** ¿El hash SHA-256 de "reto:nonce" empieza con `bits` ceros? (mismo cálculo que el navegador) */
export function pruebaValida(reto: string, nonce: string, bits: number): boolean {
  const h = createHash('sha256').update(`${reto}:${nonce}`).digest()
  for (let i = 0; i < bits; i++) {
    if ((h[i >> 3] >> (7 - (i & 7))) & 1) return false
  }
  return true
}

/** Resuelve la prueba (lo usa el navegador; aquí para pruebas automáticas). */
export function resolverPrueba(reto: string, bits: number): string {
  for (let n = 0; ; n++) if (pruebaValida(reto, String(n), bits)) return String(n)
}

/** Verificación de Cloudflare Turnstile (si se configuró la llave secreta). */
export async function verificarTurnstile(secreto: string, token: string, ip?: string): Promise<boolean> {
  const cuerpo = new URLSearchParams({ secret: secreto, response: token })
  if (ip) cuerpo.set('remoteip', ip)
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: cuerpo })
  const datos = (await r.json()) as { success?: boolean }
  return datos.success === true
}
