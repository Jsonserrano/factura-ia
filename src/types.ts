export type IvaPct = 0 | 5 | 19
export type TipoDoc = 'CC' | 'NIT' | 'CE' | 'PP'
export type MedioPago = 'Efectivo' | 'Transferencia' | 'Nequi' | 'Daviplata' | 'Tarjeta'
export type FormaPago = 'Contado' | 'Crédito'
export type EstadoFactura = 'Pendiente' | 'Pagada' | 'Anulada'

export interface Item {
  id: string
  descripcion: string
  cantidad: number
  precio: number
  descuentoPct: number
  ivaPct: IvaPct
}

export interface Cliente {
  nombre: string
  tipoDoc: TipoDoc
  documento: string
  email: string
  telefono: string
  direccion: string
}

export interface Factura {
  numero: string
  consecutivo: number
  fecha: string // ISO
  vence: string // YYYY-MM-DD
  cliente: Cliente
  items: Item[]
  formaPago: FormaPago
  medioPago: MedioPago
  retefuentePct: number
  notas: string
  estado: EstadoFactura
  cufe?: string
}

export interface Emisor {
  razonSocial: string
  nit: string
  direccion: string
  ciudad: string
  telefono: string
  email: string
  whatsapp: string // solo dígitos, con indicativo: 57300...
  resolucion: string
  prefijo: string
  claveTecnica: string
  apiKey: string // opcional: Claude API para el asistente IA
}

export interface Totales {
  bruto: number
  descuentos: number
  subtotal: number
  iva: number
  ivaPorTarifa: Record<IvaPct, { base: number; impuesto: number }>
  total: number
  retefuente: number
  netoPagar: number
}

export type ItemSugerido = Omit<Item, 'id'>
