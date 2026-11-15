import type { Emisor, Factura, Totales } from './types'

/**
 * CUFE según el Anexo Técnico de Factura Electrónica de la DIAN:
 * SHA-384( NumFac + FecFac + HorFac + ValFac + 01 + ValIVA + 04 + ValINC + 03 + ValICA
 *          + ValTot + NitOFE + NumAdq + ClTec + TipoAmbiente )
 * TipoAmbiente: 1 = producción, 2 = pruebas. Aquí siempre 2 (no se transmite a la DIAN).
 */
export const TIPO_AMBIENTE = '2' as const

const f2 = (n: number) => n.toFixed(2)

/** Fecha y hora en Colombia (UTC-05:00, sin horario de verano): igual en navegador y servidor. */
export function partesFecha(iso: string) {
  const d = new Date(new Date(iso).getTime() - 5 * 3600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const fecha = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const hora = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}-05:00`
  return { fecha, hora }
}

export function cadenaCufe(f: Factura, t: Totales, e: Emisor, ambiente: '1' | '2' = TIPO_AMBIENTE): string {
  const { fecha, hora } = partesFecha(f.fecha)
  return [
    f.numero,
    fecha,
    hora,
    f2(t.subtotal),
    '01', f2(t.iva),
    '04', f2(0),
    '03', f2(0),
    f2(t.total),
    e.nit.replace(/\D/g, ''),
    f.cliente.documento.replace(/\D/g, ''),
    e.claveTecnica,
    ambiente,
  ].join('')
}

export async function sha384(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-384', new TextEncoder().encode(texto))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Enlace de consulta de la factura en el catálogo de la DIAN (ambiente de habilitación). */
export const urlConsultaDIAN = (cufe: string) =>
  `https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${cufe}`

/**
 * Contenido del QR: el enlace de consulta DIAN con el CUFE.
 * Se deja solo el enlace (y no todos los campos) para que el QR sea poco denso
 * y cualquier celular lo lea; los demás datos ya están impresos en la factura.
 */
export function contenidoQR(_f: Factura, _t: Totales, _e: Emisor, cufe: string): string {
  return urlConsultaDIAN(cufe)
}
