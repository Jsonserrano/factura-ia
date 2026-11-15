import type { Emisor, Factura, Item } from '../src/types'
import { EMISOR_DEMO } from '../src/storage'

export const item = (p: Partial<Item> = {}): Item => ({
  id: Math.random().toString(36).slice(2),
  descripcion: 'Producto',
  cantidad: 1,
  precio: 1000,
  descuentoPct: 0,
  ivaPct: 19,
  ...p,
})

export const factura = (p: Partial<Factura> = {}): Factura => ({
  numero: 'FE0001',
  consecutivo: 1,
  fecha: '2026-11-11T15:40:00.000Z',
  vence: '2026-12-11',
  cliente: { nombre: 'Cliente Prueba', tipoDoc: 'CC', documento: '1098765432', email: '', telefono: '', direccion: '' },
  items: [item()],
  formaPago: 'Contado',
  medioPago: 'Transferencia',
  retefuentePct: 0,
  notas: '',
  estado: 'Pendiente',
  ...p,
})

export const emisor = (p: Partial<Emisor> = {}): Emisor => ({ ...EMISOR_DEMO, ...p })
