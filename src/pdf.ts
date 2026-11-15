import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { Emisor, Factura, IvaPct, Totales } from './types'
import { digitoVerificacion, numeroALetras, totalLinea } from './calc'
import { partesFecha } from './cufe'

/* ============================================================
 * Representación gráfica en PDF (tamaño carta).
 * Mismo código en el navegador (descarga) y en el servidor (adjunto del correo).
 * ============================================================ */

const TINTA = rgb(0.08, 0.08, 0.06)
const GRIS = rgb(0.43, 0.42, 0.38)
const LINEA = rgb(0.87, 0.86, 0.82)
const FONDO = rgb(0.95, 0.94, 0.91)
const ACENTO = rgb(0.78, 0.95, 0.41)

const pesos = (n: number) => '$ ' + Math.round(n).toLocaleString('es-CO').replace(/,/g, '.')

/** Las fuentes estándar de PDF usan WinAnsi: reemplaza lo que no soporta. */
const limpio = (s: string) =>
  s
    .replace(/[−–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E -ÿ·]/g, '')

export async function generarPDF(
  f: Factura,
  t: Totales,
  e: Emisor,
  cufe: string,
  qrPng: Uint8Array,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Factura ${f.numero}`)
  pdf.setAuthor(e.razonSocial)
  pdf.setSubject(`CUFE ${cufe}`)
  pdf.setProducer('Factura·IA')
  const normal = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  const mono = await pdf.embedFont(StandardFonts.Courier)
  const qr = await pdf.embedPng(qrPng)

  const W = 612
  const H = 792
  const M = 44
  let page: PDFPage = pdf.addPage([W, H])
  let y = H - M

  const texto = (s: string, x: number, yy: number, o: { size?: number; font?: PDFFont; color?: typeof TINTA } = {}) =>
    page.drawText(limpio(s), { x, y: yy, size: o.size ?? 9, font: o.font ?? normal, color: o.color ?? TINTA })
  const derecha = (s: string, xDer: number, yy: number, o: { size?: number; font?: PDFFont; color?: typeof TINTA } = {}) => {
    const size = o.size ?? 9
    const w = (o.font ?? normal).widthOfTextAtSize(limpio(s), size)
    texto(s, xDer - w, yy, o)
  }
  const cortar = (s: string, ancho: number, font: PDFFont, size: number) => {
    let r = limpio(s)
    while (font.widthOfTextAtSize(r, size) > ancho && r.length > 1) r = r.slice(0, -1)
    return r.length < limpio(s).length ? r.slice(0, -1) + '...' : r
  }

  const { fecha, hora } = partesFecha(f.fecha)
  const dvE = digitoVerificacion(e.nit)
  const c = f.cliente
  const dvC = c.tipoDoc === 'NIT' ? digitoVerificacion(c.documento) : null

  // ---------- encabezado
  texto(e.razonSocial, M, y - 18, { size: 18, font: negrita })
  texto(`NIT ${e.nit}${dvE !== null ? '-' + dvE : ''} · Responsable de IVA`, M, y - 34, { color: GRIS })
  texto(`${e.direccion} · ${e.ciudad}`, M, y - 46, { color: GRIS })
  texto([e.email, e.telefono].filter(Boolean).join(' · '), M, y - 58, { color: GRIS })
  derecha('FACTURA ELECTRÓNICA DE VENTA', W - M, y - 10, { size: 7.5, color: GRIS })
  derecha(f.numero, W - M, y - 34, { size: 22, font: negrita })
  derecha(`${fecha} · ${hora.slice(0, 5)}`, W - M, y - 48, { font: mono, color: GRIS })
  if (f.estado !== 'Pendiente') derecha(f.estado.toUpperCase(), W - M, y - 62, { font: negrita, color: f.estado === 'Anulada' ? rgb(0.8, 0.2, 0.15) : TINTA })
  y -= 74
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.6, color: TINTA })

  // ---------- cliente y pago
  y -= 20
  texto('FACTURAR A', M, y, { size: 7.5, color: GRIS, font: negrita })
  texto(c.nombre, M, y - 15, { size: 12, font: negrita })
  texto(`${c.tipoDoc} ${c.documento}${dvC !== null ? '-' + dvC : ''}`, M, y - 29)
  const extra = [c.direccion, c.email, c.telefono].filter(Boolean).join(' · ')
  if (extra) texto(cortar(extra, 300, normal, 9), M, y - 41, { color: GRIS })
  const bx = W - M - 190
  page.drawRectangle({ x: bx, y: y - 48, width: 190, height: 58, color: FONDO })
  const filasPago: [string, string][] = [
    ['Forma de pago', f.formaPago],
    ['Medio', f.medioPago],
    ['Vence', f.formaPago === 'Contado' ? fecha : f.vence],
  ]
  filasPago.forEach(([k, v], i) => {
    texto(k, bx + 10, y - 6 - i * 15, { color: GRIS })
    derecha(v, bx + 180, y - 6 - i * 15, { font: negrita })
  })
  y -= 70

  // ---------- tabla de ítems
  const cols = { n: M, desc: M + 18, cant: 340, unit: 410, dto: 455, iva: 490, total: W - M }
  const cabecera = () => {
    texto('#', cols.n, y, { size: 7.5, color: GRIS, font: negrita })
    texto('DESCRIPCIÓN', cols.desc, y, { size: 7.5, color: GRIS, font: negrita })
    derecha('CANT.', cols.cant, y, { size: 7.5, color: GRIS, font: negrita })
    derecha('V. UNIT.', cols.unit, y, { size: 7.5, color: GRIS, font: negrita })
    derecha('DESC.', cols.dto, y, { size: 7.5, color: GRIS, font: negrita })
    derecha('IVA', cols.iva, y, { size: 7.5, color: GRIS, font: negrita })
    derecha('TOTAL', cols.total, y, { size: 7.5, color: GRIS, font: negrita })
    y -= 7
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: LINEA })
    y -= 14
  }
  cabecera()
  f.items.forEach((it, i) => {
    if (y < 230) {
      page = pdf.addPage([W, H])
      y = H - M
      cabecera()
    }
    const l = totalLinea(it)
    texto(String(i + 1), cols.n, y, { color: GRIS })
    texto(cortar(it.descripcion, cols.cant - cols.desc - 40, normal, 9), cols.desc, y)
    derecha(String(it.cantidad), cols.cant, y, { font: mono })
    derecha(pesos(it.precio), cols.unit, y, { font: mono })
    derecha(it.descuentoPct ? `${it.descuentoPct}%` : '-', cols.dto, y, { font: mono })
    derecha(`${it.ivaPct}%`, cols.iva, y, { font: mono })
    derecha(pesos(l.total), cols.total, y, { font: negrita })
    y -= 8
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.4, color: LINEA })
    y -= 14
  })

  // ---------- QR + CUFE y totales
  y -= 6
  const top = y
  page.drawImage(qr, { x: M - 8, y: top - 118, width: 126, height: 126 })
  texto('CUFE', M + 122, top - 8, { size: 7.5, color: GRIS, font: negrita })
  for (let i = 0; i < 4; i++) texto(cufe.slice(i * 24, i * 24 + 24), M + 122, top - 22 - i * 10, { size: 7.5, font: mono, color: GRIS })
  texto('Escanea el QR con la cámara para', M + 122, top - 72, { size: 7.5, color: GRIS })
  texto('consultar la factura en la DIAN.', M + 122, top - 82, { size: 7.5, color: GRIS })

  const tx = W - M - 210
  let ty = top - 8
  const fila = (k: string, v: string, fuerte = false) => {
    texto(k, tx, ty, { color: fuerte ? TINTA : GRIS, font: fuerte ? negrita : normal })
    derecha(v, W - M, ty, { font: fuerte ? negrita : mono })
    ty -= 14
  }
  fila('Subtotal bruto', pesos(t.bruto))
  if (t.descuentos) fila('Descuentos', '- ' + pesos(t.descuentos))
  fila('Base gravable', pesos(t.subtotal))
  for (const k of [19, 5] as IvaPct[]) if (t.ivaPorTarifa[k].impuesto) fila(`IVA ${k}%`, pesos(t.ivaPorTarifa[k].impuesto))
  ty -= 2
  page.drawLine({ start: { x: tx, y: ty + 9 }, end: { x: W - M, y: ty + 9 }, thickness: 1.4, color: TINTA })
  ty -= 6
  const anchoTotal = negrita.widthOfTextAtSize(pesos(t.total), 16)
  page.drawRectangle({ x: W - M - anchoTotal - 2, y: ty - 4, width: anchoTotal + 4, height: 8, color: ACENTO })
  texto('TOTAL', tx, ty, { size: 9, font: negrita })
  derecha(pesos(t.total), W - M, ty, { size: 16, font: negrita })
  ty -= 20
  if (t.retefuente) {
    fila(`Retefuente ${String(f.retefuentePct).replace('.', ',')}%`, '- ' + pesos(t.retefuente))
    fila('Neto a pagar', pesos(t.netoPagar), true)
  }
  y = Math.min(top - 134, ty - 10)

  // ---------- valor en letras y notas
  page.drawRectangle({ x: M, y: y - 8, width: W - 2 * M, height: 22, color: FONDO })
  texto('Son: ', M + 10, y, { color: GRIS })
  texto(cortar(numeroALetras(t.netoPagar), W - 2 * M - 50, negrita, 9), M + 34, y, { font: negrita })
  y -= 30
  if (f.notas) {
    texto(cortar(f.notas, W - 2 * M, normal, 8.5), M, y, { size: 8.5, color: GRIS })
    y -= 16
  }

  // ---------- pie
  page.drawLine({ start: { x: M, y: 70 }, end: { x: W - M, y: 70 }, thickness: 0.5, color: LINEA, dashArray: [3, 3] })
  const pie1 = limpio(e.resolucion)
  const pie2 = 'Representación gráfica generada en ambiente de pruebas (TipoAmbiente 2) · No transmitida a la DIAN · Sin validez fiscal'
  texto(pie1, (W - normal.widthOfTextAtSize(pie1, 7.5)) / 2, 56, { size: 7.5, color: GRIS })
  texto(pie2, (W - normal.widthOfTextAtSize(pie2, 7)) / 2, 44, { size: 7, color: GRIS })
  texto('Generado con Factura·IA', (W - normal.widthOfTextAtSize('Generado con Factura·IA', 7)) / 2, 32, { size: 7, color: GRIS })

  return pdf.save()
}
