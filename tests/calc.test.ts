import { describe, expect, it } from 'vitest'
import { calcularTotales, digitoVerificacion, numeroALetras, totalLinea } from '../src/calc'
import { factura, item } from './helpers'

describe('totalLinea', () => {
  it('aplica descuento antes del IVA', () => {
    // 2 × 18.500 = 37.000 − 10% = 33.300 + IVA 19% = 39.627
    expect(totalLinea(item({ cantidad: 2, precio: 18500, descuentoPct: 10, ivaPct: 19 }))).toEqual({
      bruto: 37000,
      descuento: 3700,
      base: 33300,
      iva: 6327,
      total: 39627,
    })
  })

  it('redondea a 2 decimales', () => {
    expect(totalLinea(item({ cantidad: 3, precio: 0.333, ivaPct: 0 })).total).toBe(1)
  })
})

describe('calcularTotales', () => {
  const f = factura({
    items: [
      item({ cantidad: 3, precio: 45000, ivaPct: 19 }),
      item({ cantidad: 2, precio: 18500, descuentoPct: 10, ivaPct: 19 }),
      item({ cantidad: 1, precio: 12000, ivaPct: 0 }),
      item({ cantidad: 4, precio: 2500, ivaPct: 5 }),
    ],
    retefuentePct: 2.5,
  })
  const t = calcularTotales(f)

  it('separa bases e impuestos por tarifa', () => {
    expect(t.ivaPorTarifa[19]).toEqual({ base: 168300, impuesto: 31977 })
    expect(t.ivaPorTarifa[5]).toEqual({ base: 10000, impuesto: 500 })
    expect(t.ivaPorTarifa[0]).toEqual({ base: 12000, impuesto: 0 })
  })

  it('calcula subtotal, total, retención y neto', () => {
    expect(t.bruto).toBe(194000)
    expect(t.descuentos).toBe(3700)
    expect(t.subtotal).toBe(190300)
    expect(t.iva).toBe(32477)
    expect(t.total).toBe(222777)
    expect(t.retefuente).toBe(4757.5)
    expect(t.netoPagar).toBe(218019.5)
  })

  it('factura vacía da cero', () => {
    expect(calcularTotales(factura({ items: [] })).netoPagar).toBe(0)
  })
})

describe('digitoVerificacion (NIT, módulo 11 DIAN)', () => {
  it.each([
    ['800197268', 4], // DIAN
    ['860034313', 7], // Davivienda
    ['890903938', 8], // Bancolombia
    ['899999068', 1], // Ecopetrol
    ['800.197.268', 4], // ignora puntos
  ])('NIT %s → DV %i', (nit, dv) => {
    expect(digitoVerificacion(nit)).toBe(dv)
  })

  it('rechaza entradas sin dígitos', () => {
    expect(digitoVerificacion('abc')).toBeNull()
    expect(digitoVerificacion('')).toBeNull()
  })
})

describe('numeroALetras', () => {
  it.each([
    [0, 'cero pesos m/cte'],
    [1, 'un peso m/cte'],
    [15, 'quince pesos m/cte'],
    [21, 'veintiún pesos m/cte'],
    [100, 'cien pesos m/cte'],
    [101, 'ciento un pesos m/cte'],
    [1000, 'mil pesos m/cte'],
    [21000, 'veintiún mil pesos m/cte'],
    [31000, 'treinta y un mil pesos m/cte'],
    [100000, 'cien mil pesos m/cte'],
    [1000000, 'un millón de pesos m/cte'],
    [3000000, 'tres millones de pesos m/cte'],
    [2500000, 'dos millones quinientos mil pesos m/cte'],
    [21000000, 'veintiún millones de pesos m/cte'],
    [207770, 'doscientos siete mil setecientos setenta pesos m/cte'],
    [999999, 'novecientos noventa y nueve mil novecientos noventa y nueve pesos m/cte'],
  ])('%i → %s', (n, texto) => {
    expect(numeroALetras(n)).toBe(texto)
  })

  it('redondea los centavos', () => {
    expect(numeroALetras(207769.5)).toBe('doscientos siete mil setecientos setenta pesos m/cte')
  })
})
