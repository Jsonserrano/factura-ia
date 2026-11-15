import type { Emisor, Factura } from './types'

const K = { emisor: 'fia.emisor', historial: 'fia.historial', borrador: 'fia.borrador', version: 'fia.version' }

// localStorage puede fallar (modo privado, iframes): siempre con try/catch
function leer<T>(clave: string, defecto: T): T {
  try {
    const v = localStorage.getItem(clave)
    return v ? (JSON.parse(v) as T) : defecto
  } catch {
    return defecto
  }
}
function guardar(clave: string, valor: unknown) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor))
  } catch {
    /* sin persistencia: la app sigue funcionando en memoria */
  }
}

export const EMISOR_DEMO: Emisor = {
  razonSocial: 'Connexa S.A.S.',
  nit: '901234567',
  direccion: 'Calle 50 # 10-20',
  ciudad: 'Barrancabermeja, Santander',
  telefono: '',
  email: '', // el correo real se configura en el servidor (EMISOR_EMAIL) o en «Mi negocio», nunca en el código
  whatsapp: '', // WhatsApp del negocio que factura (aparece en la factura)
  resolucion: 'Res. DIAN 18764000000000 · Rango FE 1 – 5000 · Vigencia 24 meses',
  prefijo: 'FE',
  claveTecnica: 'fc8eac422eba16e22ffd8c6f94b3f40a6e38162c',
  apiKey: '',
}

export const store = {
  emisor: () => {
    const guardado = leer<Partial<Emisor>>(K.emisor, {})
    // Actualización única (v2): el negocio pasa a llamarse Connexa S.A.S. aunque hubiera otro nombre guardado
    if (leer<number>(K.version, 1) < 2) {
      delete guardado.razonSocial
      if (guardado.email === 'ventas@minegocio.co') delete guardado.email
      guardar(K.emisor, guardado)
      guardar(K.version, 2)
    }
    return { ...EMISOR_DEMO, ...guardado }
  },
  guardarEmisor: (e: Emisor) => guardar(K.emisor, e),
  tieneEmisorPropio: () => Object.keys(leer<Partial<Emisor>>(K.emisor, {})).length > 0,
  historial: () => leer<Factura[]>(K.historial, []),
  guardarEnHistorial(f: Factura) {
    const h = this.historial()
    const i = h.findIndex((x) => x.numero === f.numero)
    if (i >= 0) h[i] = f
    else h.unshift(f)
    guardar(K.historial, h.slice(0, 200))
  },
  borrarDeHistorial(numero: string) {
    guardar(K.historial, this.historial().filter((x) => x.numero !== numero))
  },
  siguienteConsecutivo: () => {
    const h = leer<Factura[]>(K.historial, [])
    return h.reduce((max, f) => Math.max(max, f.consecutivo), 0) + 1
  },
  borrador: () => leer<Factura | null>(K.borrador, null),
  guardarBorrador: (f: Factura) => guardar(K.borrador, f),
}
