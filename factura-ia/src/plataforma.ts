import type { ItemSugerido, IvaPct } from './types'

/* ============================================================
 * Integración opcional con el visor de artefactos de Claude.
 * Si la app corre como artefacto publicado en claude.ai, usa sus
 * capacidades (descargas, Gmail del visitante, IA, dictado).
 * En cualquier otro sitio (Render, GitHub Pages, local) todo esto
 * devuelve null y la app usa sus caminos normales.
 * ============================================================ */

type Runtime = { use: (nombre: string) => Promise<unknown> }
const runtime = (): Runtime | null => {
  const c = (window as unknown as { claude?: Runtime }).claude
  return c && typeof c.use === 'function' ? c : null
}

export const enArtefacto = () => runtime() !== null

async function capacidad<T>(nombre: string): Promise<T | null> {
  const rt = runtime()
  if (!rt) return null
  try {
    return ((await rt.use(nombre)) as T) ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- descargas
type Descargas = { save: (r: { filename: string; data: Blob | string | ArrayBufferView }) => Promise<{ status: string }> }

/** Descarga un archivo real: en el artefacto con su capacidad, en la web con un enlace temporal. */
export async function descargar(nombre: string, datos: Uint8Array | string, mime: string): Promise<'ok' | 'cancelado'> {
  const d = await capacidad<Descargas>('downloads')
  if (d) {
    try {
      await d.save({ filename: nombre, data: new Blob([datos as BlobPart], { type: mime }) })
      return 'ok'
    } catch (e) {
      if ((e as { code?: string }).code === 'declined') return 'cancelado'
      throw new Error((e as { message?: string }).message ?? 'No se pudo descargar')
    }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([datos as BlobPart], { type: mime }))
  a.download = nombre
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  return 'ok'
}

/** El visor de artefactos solo deja descargar ciertos formatos (PDF sí, XML no). */
export const puedeDescargarXml = () => !enArtefacto()

// ---------------------------------------------------------------- Gmail del visitante (solo artefacto)
type Mcp = { callTool: (server: string, tool: string, input?: unknown) => Promise<{ payload?: unknown }> }

export const gmailDisponible = async () => (await capacidad<Mcp>('mcp')) !== null

export async function enviarConGmail(opts: {
  para: string
  asunto: string
  html: string
  adjuntos: { nombre: string; base64: string; mime: string }[]
}) {
  const mcp = await capacidad<Mcp>('mcp')
  if (!mcp) throw new Error('Gmail no está disponible en esta vista')
  try {
    await mcp.callTool('Gmail', 'send_message', {
      to: [opts.para],
      subject: opts.asunto,
      htmlBody: opts.html,
      attachments: opts.adjuntos.map((a) => ({ content: a.base64, filename: a.nombre, mimeType: a.mime })),
    })
  } catch (e) {
    const code = (e as { code?: string }).code
    const mensajes: Record<string, string> = {
      server_not_connected: 'Conecta Gmail en claude.ai → Configuración → Conectores',
      needs_reauth: 'Vuelve a conectar Gmail en claude.ai → Configuración → Conectores',
      approval_required: 'Necesitas aprobar el envío con Gmail',
      not_in_manifest: 'No se autorizó el uso de Gmail para esta página',
      blocked_by_policy: 'Tu organización bloquea este envío',
    }
    throw new Error(mensajes[code ?? ''] ?? `Gmail no pudo enviar el correo (${code ?? 'error'})`)
  }
}

// ---------------------------------------------------------------- IA de Claude (solo artefacto)
type Sample = { json: (input: string, opts?: { modelTier?: string }) => Promise<unknown> }

export const iaArtefactoDisponible = async () => (await capacidad<Sample>('sample')) !== null

export async function interpretarConArtefacto(texto: string): Promise<ItemSugerido[]> {
  const s = await capacidad<Sample>('sample')
  if (!s) throw new Error('IA no disponible')
  const r = await s.json(
    'Eres un asistente de facturación en Colombia. Convierte la descripción de una venta en ítems de factura. ' +
      'Responde SOLO un JSON array. Cada ítem: {"descripcion": string, "cantidad": number, ' +
      '"precio": number (precio unitario en COP antes de IVA), "descuentoPct": number, "ivaPct": 0|5|19}. ' +
      'IVA 19 por defecto; 0 si dicen "sin IVA" o es exento; "25 mil" = 25000, "1.2 palos" = 1200000.\n\nVenta: ' +
      texto,
    { modelTier: 'quick' },
  )
  const arr = (Array.isArray(r) ? r : []) as Partial<ItemSugerido>[]
  return arr.map((i) => ({
    descripcion: String(i.descripcion ?? 'Producto'),
    cantidad: Number(i.cantidad) || 1,
    precio: Number(i.precio) || 0,
    descuentoPct: Number(i.descuentoPct) || 0,
    ivaPct: ([0, 5, 19].includes(Number(i.ivaPct)) ? Number(i.ivaPct) : 19) as IvaPct,
  }))
}

// ---------------------------------------------------------------- dictado (solo artefacto)
export type Dictado = {
  start: () => Promise<void>
  stop: () => Promise<void>
  onFinal: (cb: (e: { text: string }) => void) => void
  onState: (cb: (e: { state: string; reason?: string }) => void) => void
}
export const dictadoArtefacto = () => capacidad<Dictado>('dictation')
