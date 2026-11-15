import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import QRCode from 'qrcode'
import { PDFDocument } from 'pdf-lib'
import { abrirDB } from '../server/db'
import { crearApp, type CorreoFactura } from '../server/app'
import { generarPDF } from '../src/pdf'
import { calcularTotales } from '../src/calc'
import { emisor, factura, item } from './helpers'

const SECRETO = 'secreto-de-pruebas-con-mas-de-32-caracteres'
const qr = async () => new Uint8Array(await QRCode.toBuffer('x', { width: 100 }))

describe('generarPDF', () => {
  it('produce un PDF válido con metadatos de la factura', async () => {
    const f = factura({ notas: 'Garantía — 3 meses “oficial”' })
    const bytes = await generarPDF(f, calcularTotales(f), emisor(), 'a'.repeat(96), await qr())
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getTitle()).toBe('Factura FE0001')
  })

  it('pagina cuando hay muchos ítems', async () => {
    const f = factura({ items: Array.from({ length: 40 }, (_, i) => item({ descripcion: `Ítem número ${i + 1}` })) })
    const doc = await PDFDocument.load(await generarPDF(f, calcularTotales(f), emisor(), 'b'.repeat(96), await qr()))
    expect(doc.getPageCount()).toBeGreaterThan(1)
  })
})

describe('API: PDF y correo', () => {
  let enviados: CorreoFactura[]
  let app: ReturnType<typeof crearApp>
  let token: string
  const nueva = {
    cliente: { nombre: 'Laura Gómez', tipoDoc: 'CC', documento: '1098765432', email: 'laura@cliente.co', telefono: '', direccion: '' },
    items: [{ descripcion: 'Camisetas', cantidad: 3, precio: 45000, descuentoPct: 0, ivaPct: 19 }],
    formaPago: 'Contado',
    medioPago: 'Nequi',
    retefuentePct: 0,
    notas: '',
    vence: '2026-12-11',
  }

  beforeEach(async () => {
    enviados = []
    app = crearApp(await abrirDB(':memory:'), {
      jwtSecret: SECRETO,
      correo: { enviarFactura: async (c) => void enviados.push(c), limiteDiario: 2 },
    })
    token = (await request(app).post('/api/auth/registro').send({ nombre: 'Javier', email: 'j@e.co', password: 'clave-segura-123' })).body.token
    await request(app).post('/api/facturas').set('Authorization', `Bearer ${token}`).send(nueva)
  })

  it('anuncia el correo en /api/salud', async () => {
    expect((await request(app).get('/api/salud')).body.correo).toBe(true)
  })

  it('descarga el PDF de una factura emitida', async () => {
    const r = await request(app).get('/api/facturas/FE0001/pdf').set('Authorization', `Bearer ${token}`).buffer(true)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('application/pdf')
    expect(r.body.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('envía PDF y XML adjuntos al correo del cliente', async () => {
    const r = await request(app).post('/api/facturas/FE0001/enviar').set('Authorization', `Bearer ${token}`).send({})
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ enviado: true, para: 'laura@cliente.co' })
    const c = enviados[0]
    expect(c.asunto).toContain('FE0001')
    expect(c.adjuntos.map((a) => a.nombre)).toEqual(['FE0001.pdf', 'FE0001.xml'])
    expect(Buffer.from(c.adjuntos[0].base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-')
    expect(Buffer.from(c.adjuntos[1].base64, 'base64').toString()).toContain('<cbc:ID>FE0001</cbc:ID>')
    expect(c.html).toContain('$')
  })

  it('permite otro destinatario y limita envíos diarios', async () => {
    const auth = { Authorization: `Bearer ${token}` }
    expect((await request(app).post('/api/facturas/FE0001/enviar').set(auth).send({ email: 'otro@x.co' })).body.para).toBe('otro@x.co')
    await request(app).post('/api/facturas/FE0001/enviar').set(auth).send({})
    expect((await request(app).post('/api/facturas/FE0001/enviar').set(auth).send({})).status).toBe(429)
  })

  it('exige sesión y no envía facturas anuladas', async () => {
    expect((await request(app).post('/api/facturas/FE0001/enviar').send({})).status).toBe(401)
    const auth = { Authorization: `Bearer ${token}` }
    await request(app).patch('/api/facturas/FE0001/estado').set(auth).send({ estado: 'Anulada' })
    expect((await request(app).post('/api/facturas/FE0001/enviar').set(auth).send({})).status).toBe(409)
  })

  it('sin Brevo configurado responde 503', async () => {
    const sin = crearApp(await abrirDB(':memory:'), { jwtSecret: SECRETO })
    const t = (await request(sin).post('/api/auth/registro').send({ nombre: 'Xavi', email: 'x@e.co', password: 'clave-segura-123' })).body.token
    await request(sin).post('/api/facturas').set('Authorization', `Bearer ${t}`).send(nueva)
    expect((await request(sin).post('/api/facturas/FE0001/enviar').set('Authorization', `Bearer ${t}`).send({})).status).toBe(503)
  })
})
