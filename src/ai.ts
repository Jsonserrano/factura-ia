import type { IvaPct, ItemSugerido } from './types'

/* ============================================================
 * Asistente IA: convierte lenguaje natural (texto o voz) en ítems.
 *  1) Parser local: funciona siempre, sin internet ni llaves.
 *  2) Claude API (opcional): si el usuario configura su API key,
 *     se usa el modelo para entender frases más libres.
 * ============================================================ */

const NUM = String.raw`\d+(?:[.,]\d+)*`

/** "18.500" -> 18500 · "18,500" -> 18500 · "1.5" -> 1.5 · "2,5" -> 2.5 */
export function parseNumero(raw: string): number {
  const s = raw.trim()
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''))
  return Number(s.replace(',', '.'))
}

function multiplicador(sufijo?: string): number {
  if (!sufijo) return 1
  const s = sufijo.toLowerCase()
  if (s === 'k' || s === 'mil' || s === 'lucas' || s === 'luca') return 1_000
  if (s.startsWith('mill') || s === 'm' || s === 'palos' || s === 'palo') return 1_000_000
  return 1
}

const capitalizar = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

export function parsearLinea(linea: string): ItemSugerido | null {
  let txt = ` ${linea.trim()} `
  if (!txt.trim()) return null

  // IVA
  let ivaPct: IvaPct = 19
  if (/\b(sin iva|exent[oa]|excluid[oa]|iva\s*0)\b/i.test(txt)) ivaPct = 0
  else if (/\biva\s*(del\s*)?5\s*%?/i.test(txt)) ivaPct = 5
  txt = txt.replace(/\b(sin iva|exent[oa]|excluid[oa]|con iva|iva\s*(del\s*)?\d{1,2}\s*%?)\b/gi, ' ')

  // Descuento
  let descuentoPct = 0
  const desc =
    txt.match(new RegExp(String.raw`(?:desc(?:uento)?|dto)\.?\s*(?:del?\s*)?(${NUM})\s*%`, 'i')) ??
    txt.match(new RegExp(String.raw`(${NUM})\s*%\s*(?:de\s*)?(?:desc(?:uento)?|dto)`, 'i'))
  if (desc) {
    descuentoPct = Math.min(100, parseNumero(desc[1]))
    txt = txt.replace(desc[0], ' ')
  }

  // Cantidad al inicio: "3 camisas", "3x camisa", "3 und de ..."
  let cantidad = 1
  const cant = txt.match(new RegExp(String.raw`^\s*(${NUM})\s*(?:x|unidades?|unds?\.?|uds?\.?)?\s+(?=\D)`, 'i'))
  if (cant) {
    cantidad = parseNumero(cant[1])
    txt = txt.slice(cant[0].length)
  }

  // Precio: el último valor monetario de la frase
  const rePrecio = new RegExp(
    String.raw`(?:\ba\b|\bpor\b|\ben\b|\bde\b|\bvalor\b|\bprecio\b|=|:)?\s*\$?\s*(${NUM})\s*(k|mil|lucas?|millones?|mill|palos?|m)?\b\s*(?:c\/u|cada\s+un[oa]|c\/una|la\s+unidad)?`,
    'gi',
  )
  const matches = [...txt.matchAll(rePrecio)]
  let precio = 0
  if (matches.length) {
    const ult = matches[matches.length - 1]
    precio = parseNumero(ult[1]) * multiplicador(ult[2])
    txt = txt.slice(0, ult.index) + ' ' + txt.slice((ult.index ?? 0) + ult[0].length)
  }

  const descripcion = capitalizar(
    txt
      .replace(/\$/g, ' ')
      .replace(/\b(con|de|del|a|por|en|cada uno|cada una|valor|precio)\s*$/i, ' ')
      .replace(/\b(con|de|del|a|por|en|cada uno|cada una|valor|precio)\s*$/i, ' ')
      .replace(/^\s*(de|del)\b/i, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  if (!descripcion && !precio) return null
  return { descripcion: descripcion || 'Producto', cantidad: cantidad || 1, precio, descuentoPct, ivaPct }
}

export function parsearTextoLocal(texto: string): ItemSugerido[] {
  return texto
    .split(/\n|;|,\s+|\s+y\s+(?=\d)/i)
    .map(parsearLinea)
    .filter((x): x is ItemSugerido => x !== null)
}

/** Llama a Claude (Anthropic API) directamente desde el navegador con la key del usuario. */
export async function parsearConClaude(texto: string, apiKey: string): Promise<ItemSugerido[]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 1024,
      system:
        'Eres un asistente de facturación en Colombia. Convierte la descripción de una venta en ítems de factura. ' +
        'Responde SOLO con un JSON array, sin texto extra. Cada ítem: ' +
        '{"descripcion": string, "cantidad": number, "precio": number (precio unitario en COP antes de IVA), ' +
        '"descuentoPct": number, "ivaPct": 0|5|19}. Usa IVA 19 por defecto; 0 para alimentos básicos, ' +
        'servicios exentos o si dicen "sin IVA"; 5 si aplica. "25 mil" = 25000, "1.2 palos" = 1200000.',
      messages: [{ role: 'user', content: texto }],
    }),
  })
  if (!res.ok) throw new Error(`Claude API ${res.status}`)
  const data = (await res.json()) as { content: { type: string; text?: string }[] }
  const raw = data.content.find((c) => c.type === 'text')?.text ?? '[]'
  const json = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)
  const arr = JSON.parse(json) as Partial<ItemSugerido>[]
  return arr.map((i) => ({
    descripcion: String(i.descripcion ?? 'Producto'),
    cantidad: Number(i.cantidad) || 1,
    precio: Number(i.precio) || 0,
    descuentoPct: Number(i.descuentoPct) || 0,
    ivaPct: ([0, 5, 19].includes(Number(i.ivaPct)) ? Number(i.ivaPct) : 19) as IvaPct,
  }))
}

/**
 * Orden: 1) llave propia del usuario → Claude directo
 *        2) IA del servidor (/api/ia, la llave vive en el backend)
 *        3) parser local
 */
export async function interpretar(
  texto: string,
  apiKey: string,
  servidor?: (texto: string) => Promise<ItemSugerido[]>,
): Promise<{ items: ItemSugerido[]; motor: string }> {
  if (apiKey.trim()) {
    try {
      return { items: await parsearConClaude(texto, apiKey.trim()), motor: 'Claude' }
    } catch (err) {
      console.warn('Claude no disponible, usando parser local', err)
    }
  } else if (servidor) {
    try {
      const items = await servidor(texto)
      if (items.length) return { items, motor: 'Claude' }
    } catch (err) {
      console.warn('IA del servidor no disponible, usando parser local', err)
    }
  }
  return { items: parsearTextoLocal(texto), motor: 'local' }
}

// ---------- Dictado por voz (Web Speech API) ----------
type SpeechRec = {
  lang: string
  interimResults: boolean
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void
  onerror: (e: { error: string }) => void
  onend: () => void
  start: () => void
  stop: () => void
}

export function crearDictado(): SpeechRec | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) return null
  const rec = new Ctor()
  rec.lang = 'es-CO'
  rec.interimResults = false
  return rec
}
