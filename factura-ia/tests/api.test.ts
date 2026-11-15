import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { abrirDB } from '../server/db'
import { crearApp } from '../server/app'

const SECRETO = 'secreto-de-pruebas-con-mas-de-32-caracteres'

const nuevaFactura = (p: Record<string, unknown> = {}) => ({
  cliente: { nombre: 'Laura Gómez', tipoDoc: 'CC', documento: '1098765432', email: '', telefono: '3001234567', direccion: '' },
  items: [{ descripcion: 'Camisetas', cantidad: 3, precio: 45000, descuentoPct: 0, ivaPct: 19 }],
  formaPago: 'Contado',
  medioPago: 'Nequi',
  retefuentePct: 0,
  notas: '',
  vence: '2026-12-11',
  ...p,
})

let app: ReturnType<typeof crearApp>

async function registrar(email = 'javier@ejemplo.co') {
  const r = await request(app).post('/api/auth/registro').send({ nombre: 'Javier Reina', email, password: 'clave-segura-123' })
  return r.body.token as string
}

beforeEach(async () => {
  app = crearApp(await abrirDB(':memory:'), { jwtSecret: SECRETO })
})

describe('salud', () => {
  it('GET /api/salud', async () => {
    const r = await request(app).get('/api/salud')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })
})

describe('usuarios', () => {
  it('registra y devuelve token', async () => {
    const r = await request(app).post('/api/auth/registro').send({ nombre: 'Javier', email: 'j@e.co', password: 'clave-segura-123' })
    expect(r.status).toBe(201)
    expect(r.body.token).toBeTypeOf('string')
    expect(r.body.usuario).toMatchObject({ email: 'j@e.co', nombre: 'Javier' })
  })

  it('no permite correos repetidos (sin importar mayúsculas)', async () => {
    await registrar('a@b.co')
    const r = await request(app).post('/api/auth/registro').send({ nombre: 'Otro', email: 'A@B.co', password: 'clave-segura-123' })
    expect(r.status).toBe(409)
  })

  it('valida la contraseña mínima', async () => {
    const r = await request(app).post('/api/auth/registro').send({ nombre: 'X', email: 'x@y.co', password: '123' })
    expect(r.status).toBe(400)
  })

  it('login correcto e incorrecto', async () => {
    await registrar()
    const ok = await request(app).post('/api/auth/login').send({ email: 'javier@ejemplo.co', password: 'clave-segura-123' })
    expect(ok.status).toBe(200)
    const mal = await request(app).post('/api/auth/login').send({ email: 'javier@ejemplo.co', password: 'otra-clave-xx' })
    expect(mal.status).toBe(401)
    expect(mal.body.error).toBe('Correo o contraseña incorrectos')
  })

  it('rutas protegidas exigen token válido', async () => {
    expect((await request(app).get('/api/facturas')).status).toBe(401)
    expect((await request(app).get('/api/facturas').set('Authorization', 'Bearer basura')).status).toBe(401)
    const token = await registrar()
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`)
    expect(me.body.email).toBe('javier@ejemplo.co')
  })
})

describe('facturas', () => {
  it('emite con consecutivo, CUFE y totales calculados por el servidor', async () => {
    const token = await registrar()
    const r = await request(app).post('/api/facturas').set('Authorization', `Bearer ${token}`).send(nuevaFactura())
    expect(r.status).toBe(201)
    expect(r.body.factura.numero).toBe('FE0001')
    expect(r.body.factura.cufe).toMatch(/^[a-f0-9]{96}$/)
    expect(r.body.totales.total).toBe(160650)
  })

  it('el consecutivo avanza y es independiente por usuario', async () => {
    const a = await registrar('a@b.co')
    const b = await registrar('c@d.co')
    const emitir = (t: string) => request(app).post('/api/facturas').set('Authorization', `Bearer ${t}`).send(nuevaFactura())
    expect((await emitir(a)).body.factura.numero).toBe('FE0001')
    expect((await emitir(a)).body.factura.numero).toBe('FE0002')
    expect((await emitir(b)).body.factura.numero).toBe('FE0001')
    const lista = await request(app).get('/api/facturas').set('Authorization', `Bearer ${a}`)
    expect(lista.body.map((f: { numero: string }) => f.numero)).toEqual(['FE0002', 'FE0001'])
  })

  it('un usuario no ve las facturas de otro', async () => {
    const a = await registrar('a@b.co')
    const b = await registrar('c@d.co')
    await request(app).post('/api/facturas').set('Authorization', `Bearer ${a}`).send(nuevaFactura())
    const r = await request(app).get('/api/facturas/FE0001').set('Authorization', `Bearer ${b}`)
    expect(r.status).toBe(404)
  })

  it('rechaza datos inválidos', async () => {
    const t = await registrar()
    const r = await request(app)
      .post('/api/facturas')
      .set('Authorization', `Bearer ${t}`)
      .send(nuevaFactura({ items: [{ descripcion: '', cantidad: -1, precio: 0, ivaPct: 16 }] }))
    expect(r.status).toBe(400)
    expect(r.body.detalles.length).toBeGreaterThan(0)
  })

  it('marca pagada una sola vez y calcula el resumen', async () => {
    const t = await registrar()
    const auth = { Authorization: `Bearer ${t}` }
    await request(app).post('/api/facturas').set(auth).send(nuevaFactura())
    await request(app).post('/api/facturas').set(auth).send(nuevaFactura())
    expect((await request(app).patch('/api/facturas/FE0001/estado').set(auth).send({ estado: 'Pagada' })).status).toBe(200)
    expect((await request(app).patch('/api/facturas/FE0001/estado').set(auth).send({ estado: 'Anulada' })).status).toBe(409)
    await request(app).patch('/api/facturas/FE0002/estado').set(auth).send({ estado: 'Anulada' })
    const res = await request(app).get('/api/facturas/resumen').set(auth)
    expect(res.body).toEqual({ facturas: 2, facturado: 160650, porCobrar: 0 })
  })

  it('usa los datos del negocio del usuario (prefijo propio)', async () => {
    const t = await registrar()
    const auth = { Authorization: `Bearer ${t}` }
    const emisor = (await request(app).get('/api/emisor').set(auth)).body
    const put = await request(app).put('/api/emisor').set(auth).send({ ...emisor, apiKey: undefined, prefijo: 'SETT' })
    expect(put.status).toBe(200)
    const r = await request(app).post('/api/facturas').set(auth).send(nuevaFactura())
    expect(r.body.factura.numero).toBe('SETT0001')
  })

  it('descarga el XML UBL 2.1', async () => {
    const t = await registrar()
    const auth = { Authorization: `Bearer ${t}` }
    const { body } = await request(app).post('/api/facturas').set(auth).send(nuevaFactura())
    const r = await request(app).get('/api/facturas/FE0001/xml').set(auth)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('application/xml')
    expect(r.text).toContain(`<cbc:UUID schemeID="2" schemeName="CUFE-SHA384">${body.factura.cufe}</cbc:UUID>`)
  })

  it('404 en rutas inexistentes de la API', async () => {
    expect((await request(app).get('/api/nada')).status).toBe(404)
  })
})

describe('IA del servidor (/api/ia)', () => {
  it('responde 503 si el servidor no tiene llave', async () => {
    const r = await request(app).post('/api/ia').send({ texto: '2 almuerzos a 18 mil' })
    expect(r.status).toBe(503)
  })

  it('usa Claude con la llave del servidor y limita por IP', async () => {
    const { vi } = await import('vitest')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: '[{"descripcion":"Almuerzo","cantidad":2,"precio":18000,"ivaPct":0}]' }] }),
      }),
    )
    const conIA = crearApp(await abrirDB(':memory:'), { jwtSecret: SECRETO, anthropicKey: 'sk-ant-servidor', limiteIA: 2 })
    const salud = await request(conIA).get('/api/salud')
    expect(salud.body.ia).toBe(true)
    const r = await request(conIA).post('/api/ia').send({ texto: '2 almuerzos a 18 mil' })
    expect(r.status).toBe(200)
    expect(r.body.items[0]).toMatchObject({ descripcion: 'Almuerzo', cantidad: 2, precio: 18000, ivaPct: 0 })
    await request(conIA).post('/api/ia').send({ texto: 'otra' })
    expect((await request(conIA).post('/api/ia').send({ texto: 'tercera' })).status).toBe(429)
    vi.unstubAllGlobals()
  })
})

describe('datos del negocio desde el servidor', () => {
  it('el correo se toma de la configuración del servidor, no del código', async () => {
    const conDatos = crearApp(await abrirDB(':memory:'), {
      jwtSecret: SECRETO,
      emisorPredeterminado: { razonSocial: 'Connexa S.A.S.', email: 'contacto@ejemplo.co' },
    })
    const r = await request(conDatos).get('/api/emisor/predeterminado')
    expect(r.body).toMatchObject({ razonSocial: 'Connexa S.A.S.', email: 'contacto@ejemplo.co', apiKey: '' })
    const t = (await request(conDatos).post('/api/auth/registro').send({ nombre: 'Javier', email: 'j@x.co', password: 'clave-segura-123' })).body.token
    expect((await request(conDatos).get('/api/emisor').set('Authorization', `Bearer ${t}`)).body.email).toBe('contacto@ejemplo.co')
  })
})
