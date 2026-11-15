import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { cadenaCufe, contenidoQR, partesFecha, sha384 } from '../src/cufe'
import { calcularTotales } from '../src/calc'
import { generarUBL } from '../src/ubl'
import { emisor, factura, item } from './helpers'

describe('partesFecha', () => {
  it('siempre en hora de Colombia (UTC-05:00)', () => {
    expect(partesFecha('2019-01-16T15:53:10Z')).toEqual({ fecha: '2019-01-16', hora: '10:53:10-05:00' })
    // pasada la medianoche UTC sigue siendo el día anterior en Bogotá
    expect(partesFecha('2026-11-12T03:00:00Z')).toEqual({ fecha: '2026-11-11', hora: '22:00:00-05:00' })
  })
})

describe('CUFE', () => {
  it('sha384 coincide con node:crypto', async () => {
    const txt = 'Factura·IA ñ'
    expect(await sha384(txt)).toBe(createHash('sha384').update(txt).digest('hex'))
  })

  it('reproduce el ejemplo oficial del Anexo Técnico DIAN', async () => {
    const f = factura({
      numero: '323200000129',
      fecha: '2019-01-16T15:53:10Z',
      items: [item({ cantidad: 1, precio: 1_500_000, ivaPct: 19 })],
      cliente: { nombre: 'Adquiriente', tipoDoc: 'NIT', documento: '800199436', email: '', telefono: '', direccion: '' },
    })
    const e = emisor({ nit: '700085371', claveTecnica: '693ff6f2a553c3646a063436fd4dd9ded0311471' })
    const cadena = cadenaCufe(f, calcularTotales(f), e, '1')
    expect(cadena).toBe(
      '3232000001292019-01-1610:53:10-05:001500000.0001285000.00040.00030.001785000.00700085371800199436693ff6f2a553c3646a063436fd4dd9ded03114711',
    )
    expect(await sha384(cadena)).toBe(
      '8bb918b19ba22a694f1da11c643b5e9de39adf60311cf179179e9b33381030bcd4c3c3f156c506ed5908f9276f5bd9b4',
    )
  })

  it('cambia si cambia cualquier valor', async () => {
    const e = emisor()
    const a = factura()
    const b = factura({ items: [item({ precio: 1001 })] })
    expect(await sha384(cadenaCufe(a, calcularTotales(a), e))).not.toBe(await sha384(cadenaCufe(b, calcularTotales(b), e)))
  })

  it('el QR lleva el enlace de consulta DIAN con el CUFE y es corto (legible con cámara)', () => {
    const f = factura()
    const cufe = 'a'.repeat(96)
    const qr = contenidoQR(f, calcularTotales(f), emisor(), cufe)
    expect(qr).toBe(`https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${cufe}`)
    expect(qr.length).toBeLessThan(200)
  })
})

describe('XML UBL 2.1', () => {
  const f = factura({
    notas: 'Gracias por su compra & vuelva pronto <3',
    retefuentePct: 2.5,
    cliente: { nombre: 'Distribuciones Andina S.A.S.', tipoDoc: 'NIT', documento: '900373115', email: 'a@b.co', telefono: '', direccion: '' },
    items: [
      item({ descripcion: 'Camisetas', cantidad: 3, precio: 45000 }),
      item({ descripcion: 'Gorras', cantidad: 2, precio: 18500, descuentoPct: 10 }),
      item({ descripcion: 'Envío', cantidad: 1, precio: 12000, ivaPct: 0 }),
    ],
  })
  const t = calcularTotales(f)
  const xml = generarUBL(f, t, emisor(), 'cufe123')
  const doc = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(xml).Invoice

  it('es XML bien formado (con caracteres escapados)', () => {
    expect(XMLValidator.validate(xml)).toBe(true)
    expect(xml).toContain('&amp; vuelva pronto &lt;3')
  })

  it('cabecera DIAN', () => {
    expect(doc.UBLVersionID).toBe('UBL 2.1')
    expect(doc.ProfileID).toBe('DIAN 2.1: Factura Electrónica de Venta')
    expect(doc.ID).toBe('FE0001')
    expect(doc.UUID['#text']).toBe('cufe123')
    expect(doc.UUID['@_schemeName']).toBe('CUFE-SHA384')
    expect(doc.InvoiceTypeCode).toBe('01')
    expect(doc.LineCountNumeric).toBe('3')
  })

  it('totales cuadran con el cálculo', () => {
    const lmt = doc.LegalMonetaryTotal
    expect(Number(lmt.LineExtensionAmount['#text'])).toBe(t.subtotal)
    expect(Number(lmt.TaxInclusiveAmount['#text'])).toBe(t.total)
    expect(Number(lmt.PayableAmount['#text'])).toBe(t.total)
    expect(Number(doc.TaxTotal.TaxAmount['#text'])).toBe(t.iva)
    expect(Number(doc.WithholdingTaxTotal.TaxAmount['#text'])).toBe(t.retefuente)
  })

  it('una línea por ítem con su descuento', () => {
    expect(doc.InvoiceLine).toHaveLength(3)
    expect(Number(doc.InvoiceLine[1].AllowanceCharge.Amount['#text'])).toBe(3700)
    expect(doc.InvoiceLine[2].Item.Description).toBe('Envío')
  })

  it('identifica al adquiriente con NIT y DV', () => {
    const id = doc.AccountingCustomerParty.Party.PartyTaxScheme.CompanyID
    expect(id['#text']).toBe('900373115')
    expect(id['@_schemeID']).toBe('3')
    expect(id['@_schemeName']).toBe('31')
  })
})
