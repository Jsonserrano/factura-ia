import type { Factura, IvaPct, Item, Totales } from './types'

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function totalLinea(it: Item) {
  const bruto = it.cantidad * it.precio
  const descuento = bruto * (it.descuentoPct / 100)
  const base = bruto - descuento
  const iva = base * (it.ivaPct / 100)
  return { bruto: r2(bruto), descuento: r2(descuento), base: r2(base), iva: r2(iva), total: r2(base + iva) }
}

export function calcularTotales(f: Factura): Totales {
  const ivaPorTarifa: Totales['ivaPorTarifa'] = {
    0: { base: 0, impuesto: 0 },
    5: { base: 0, impuesto: 0 },
    19: { base: 0, impuesto: 0 },
  }
  let bruto = 0
  let descuentos = 0
  for (const it of f.items) {
    const l = totalLinea(it)
    bruto += l.bruto
    descuentos += l.descuento
    ivaPorTarifa[it.ivaPct as IvaPct].base += l.base
    ivaPorTarifa[it.ivaPct as IvaPct].impuesto += l.iva
  }
  const subtotal = r2(bruto - descuentos)
  const iva = r2(ivaPorTarifa[0].impuesto + ivaPorTarifa[5].impuesto + ivaPorTarifa[19].impuesto)
  const total = r2(subtotal + iva)
  const retefuente = r2(subtotal * (f.retefuentePct / 100))
  for (const k of [0, 5, 19] as IvaPct[]) {
    ivaPorTarifa[k].base = r2(ivaPorTarifa[k].base)
    ivaPorTarifa[k].impuesto = r2(ivaPorTarifa[k].impuesto)
  }
  return {
    bruto: r2(bruto),
    descuentos: r2(descuentos),
    subtotal,
    iva,
    ivaPorTarifa,
    total,
    retefuente,
    netoPagar: r2(total - retefuente),
  }
}

export const cop = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
})

/** Dígito de verificación del NIT (algoritmo oficial DIAN, módulo 11). */
export function digitoVerificacion(nit: string): number | null {
  const limpio = nit.replace(/\D/g, '')
  if (!limpio || limpio.length > 15) return null
  const pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71]
  let suma = 0
  const digitos = limpio.split('').reverse()
  digitos.forEach((d, i) => (suma += Number(d) * pesos[i]))
  const residuo = suma % 11
  return residuo > 1 ? 11 - residuo : residuo
}

// ---------- Número a letras (español, pesos colombianos) ----------
const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve']
const ESPECIALES = [
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete',
  'veintiocho', 'veintinueve',
]
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa']
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos',
  'setecientos', 'ochocientos', 'novecientos']

function hasta999(n: number): string {
  if (n === 0) return ''
  if (n === 100) return 'cien'
  const c = Math.floor(n / 100)
  const resto = n % 100
  const partes: string[] = []
  if (c) partes.push(CENTENAS[c])
  if (resto >= 10 && resto < 30) partes.push(ESPECIALES[resto - 10])
  else if (resto >= 30) {
    const d = Math.floor(resto / 10)
    const u = resto % 10
    partes.push(u ? `${DECENAS[d]} y ${UNIDADES[u]}` : DECENAS[d])
  } else if (resto > 0) partes.push(UNIDADES[resto])
  return partes.join(' ')
}

/** "uno" -> "un" cuando precede a mil / millones ("veintiún mil", "un millón"). */
const apocopar = (s: string) => s.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un')

export function numeroALetras(valor: number): string {
  const n = Math.round(valor)
  if (n === 0) return 'cero pesos m/cte'
  if (n === 1) return 'un peso m/cte'
  const millones = Math.floor(n / 1_000_000)
  const miles = Math.floor((n % 1_000_000) / 1000)
  const unidades = n % 1000
  const partes: string[] = []
  if (millones) {
    partes.push(millones === 1 ? 'un millón' : `${apocopar(numeroSinPesos(millones))} millones`)
  }
  if (miles) partes.push(miles === 1 ? 'mil' : `${apocopar(hasta999(miles))} mil`)
  if (unidades) partes.push(apocopar(hasta999(unidades)))
  const texto = partes.join(' ')
  const conDe = millones && !miles && !unidades ? ' de' : ''
  return `${texto}${conDe} pesos m/cte`
}

function numeroSinPesos(n: number): string {
  // Para el bloque de millones (hasta 999.999)
  const miles = Math.floor(n / 1000)
  const unidades = n % 1000
  const p: string[] = []
  if (miles) p.push(miles === 1 ? 'mil' : `${apocopar(hasta999(miles))} mil`)
  if (unidades) p.push(hasta999(unidades))
  return p.join(' ')
}
