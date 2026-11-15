import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { abrirDB } from '../server/db'
import { crearApp } from '../server/app'
import { crearReto, firmaValida, pruebaValida, resolverPrueba } from '../server/contacto'

const SECRETO = 'secreto-de-pruebas-con-mas-de-32-caracteres'
const NUMERO = '570000000000'
const DIF = 8 // dificultad baja para que las pruebas sean rápidas

describe('reto y prueba de trabajo', () => {
  it('la firma detecta cualquier alteración', () => {
    const r = crearReto(SECRETO, DIF)
    expect(firmaValida(SECRETO, r)).toBe(true)
    expect(firmaValida(SECRETO, { ...r, dificultad: 1 })).toBe(false)
    expect(firmaValida(SECRETO, { ...r, emitido: r.emitido + 1 })).toBe(false)
    expect(firmaValida('otro-secreto-de-mas-de-32-caracteres-xx', r)).toBe(false)
  })

  it('la prueba de trabajo exige los bits pedidos', () => {
    const r = crearReto(SECRETO, 12)
    const nonce = resolverPrueba(r.reto, 12)
    expect(pruebaValida(r.reto, nonce, 12)).toBe(true)
    expect(pruebaValida(r.reto, String(Number(nonce) + 1), 12)).toBe(false)
  })
})

describe('API: WhatsApp directo', () => {
  let app: ReturnType<typeof crearApp>

  const resolver = async (extra: Record<string, unknown> = {}) => {
    const r = (await request(app).get('/api/contacto/reto')).body
    return { ...r, nonce: resolverPrueba(r.reto, r.dificultad), msEnPagina: 6000, interacciones: 4, ...extra }
  }

  beforeEach(async () => {
    app = crearApp(await abrirDB(':memory:'), {
      jwtSecret: SECRETO,
      contacto: { whatsapp: NUMERO, nombre: 'Javier', dificultad: DIF, porIpDia: 3, globalDia: 100 },
    })
  })

  it('sin número configurado el botón queda apagado', async () => {
    const sin = crearApp(await abrirDB(':memory:'), { jwtSecret: SECRETO })
    expect((await request(sin).get('/api/contacto/estado')).body.disponible).toBe(false)
    expect((await request(sin).get('/api/contacto/reto')).status).toBe(503)
  })

  it('el número nunca aparece en el estado ni en el reto', async () => {
    const estado = await request(app).get('/api/contacto/estado')
    const reto = await request(app).get('/api/contacto/reto')
    expect(estado.body.disponible).toBe(true)
    expect(JSON.stringify(estado.body) + JSON.stringify(reto.body)).not.toContain(NUMERO)
  })

  it('una persona que resolvió la verificación recibe el enlace directo', async () => {
    const r = await request(app).post('/api/contacto/whatsapp').send(await resolver())
    expect(r.status).toBe(200)
    expect(r.body.url).toMatch(new RegExp(`^https://wa\\.me/${NUMERO}\\?text=`))
    expect(decodeURIComponent(r.body.url)).toContain('Hola Javier, vi tu proyecto Factura·IA')
  })

  it('rechaza prueba de trabajo falsa', async () => {
    const d = await resolver()
    const malo = pruebaValida(d.reto, '0', DIF) ? '1' : '0'
    expect((await request(app).post('/api/contacto/whatsapp').send({ ...d, nonce: malo })).status).toBe(403)
  })

  it('rechaza retos inventados o alterados', async () => {
    const d = await resolver()
    expect((await request(app).post('/api/contacto/whatsapp').send({ ...d, firma: 'a'.repeat(64) })).status).toBe(403)
    expect((await request(app).post('/api/contacto/whatsapp').send({ ...d, dificultad: 1 })).status).toBe(403)
  })

  it('cada reto sirve una sola vez', async () => {
    const d = await resolver()
    expect((await request(app).post('/api/contacto/whatsapp').send(d)).status).toBe(200)
    expect((await request(app).post('/api/contacto/whatsapp').send(d)).status).toBe(403)
  })

  it('rechaza bots sin interacción o demasiado rápidos', async () => {
    expect((await request(app).post('/api/contacto/whatsapp').send(await resolver({ interacciones: 0 }))).status).toBe(403)
    expect((await request(app).post('/api/contacto/whatsapp').send(await resolver({ msEnPagina: 300 }))).status).toBe(403)
  })

  it('rechaza retos vencidos', async () => {
    const viejo = crearReto(SECRETO, DIF, Date.now() - 5 * 60_000)
    const d = { ...viejo, nonce: resolverPrueba(viejo.reto, DIF), msEnPagina: 6000, interacciones: 3 }
    expect((await request(app).post('/api/contacto/whatsapp').send(d)).status).toBe(403)
  })

  it('limita las veces por IP al día', async () => {
    for (let i = 0; i < 3; i++) expect((await request(app).post('/api/contacto/whatsapp').send(await resolver())).status).toBe(200)
    expect((await request(app).post('/api/contacto/whatsapp').send(await resolver())).status).toBe(429)
  })
})
