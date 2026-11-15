import { afterEach, describe, expect, it, vi } from 'vitest'
import { interpretar, parseNumero, parsearLinea, parsearTextoLocal } from '../src/ai'

describe('parseNumero', () => {
  it.each([
    ['18.500', 18500],
    ['18,500', 18500],
    ['1.250.000', 1250000],
    ['1.5', 1.5],
    ['2,5', 2.5],
    ['45000', 45000],
  ])('%s → %d', (txt, n) => expect(parseNumero(txt)).toBe(n))
})

describe('parsearLinea', () => {
  it('cantidad, descripción y precio con "mil"', () => {
    expect(parsearLinea('3 camisetas a 45 mil')).toMatchObject({ descripcion: 'Camisetas', cantidad: 3, precio: 45000, ivaPct: 19 })
  })
  it('descuento y separador de miles', () => {
    expect(parsearLinea('2 gorras 18.500 con 10% de descuento')).toMatchObject({ descripcion: 'Gorras', cantidad: 2, precio: 18500, descuentoPct: 10 })
  })
  it('sin IVA / exento', () => {
    expect(parsearLinea('envío 12000 sin iva')).toMatchObject({ descripcion: 'Envío', precio: 12000, ivaPct: 0 })
    expect(parsearLinea('5x arroz 3500 exento')).toMatchObject({ cantidad: 5, descripcion: 'Arroz', ivaPct: 0 })
  })
  it('IVA del 5%', () => {
    expect(parsearLinea('servicio de parqueadero 8000 iva 5')).toMatchObject({ precio: 8000, ivaPct: 5 })
  })
  it('jerga: k, palos y signo $', () => {
    expect(parsearLinea('corte de cabello 25k')?.precio).toBe(25000)
    expect(parsearLinea('portátil 2 palos')?.precio).toBe(2_000_000)
    expect(parsearLinea('2 hamburguesas a $15.000')).toMatchObject({ cantidad: 2, precio: 15000 })
  })
  it('ignora líneas vacías', () => {
    expect(parsearLinea('   ')).toBeNull()
  })
})

describe('parsearTextoLocal', () => {
  it('divide una frase con varios productos', () => {
    const items = parsearTextoLocal('3 camisetas a 45 mil, 2 gorras 18.500 con 10% de descuento, envío 12000 sin iva')
    expect(items.map((i) => [i.descripcion, i.cantidad, i.precio])).toEqual([
      ['Camisetas', 3, 45000],
      ['Gorras', 2, 18500],
      ['Envío', 1, 12000],
    ])
  })
  it('acepta saltos de línea', () => {
    expect(parsearTextoLocal('almuerzo 18000\njugo 6000')).toHaveLength(2)
  })
})

describe('interpretar (IA)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sin API key usa el parser local', async () => {
    const r = await interpretar('2 almuerzos a 18 mil', '')
    expect(r.motor).toBe('local')
    expect(r.items[0]).toMatchObject({ cantidad: 2, precio: 18000 })
  })

  it('con API key usa Claude y normaliza la respuesta', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Listo: [{"descripcion":"Pizza","cantidad":"2","precio":30000,"ivaPct":8}]' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await interpretar('dos pizzas de 30 lucas', 'sk-ant-prueba')
    expect(r.motor).toBe('Claude')
    expect(r.items).toEqual([{ descripcion: 'Pizza', cantidad: 2, precio: 30000, descuentoPct: 0, ivaPct: 19 }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers['x-api-key']).toBe('sk-ant-prueba')
  })

  it('si Claude falla, vuelve al parser local', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await interpretar('jugo 6000', 'sk-ant-prueba')
    expect(r.motor).toBe('local')
    expect(r.items[0].precio).toBe(6000)
  })
})
