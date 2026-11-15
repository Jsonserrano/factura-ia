import type { Emisor, Factura, ItemSugerido } from './types'

/** URL del backend: VITE_API_URL en build, o el mismo origen cuando Express sirve el frontend. */
const BASE = (import.meta.env?.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const K_TOKEN = 'fia.token'
const K_USUARIO = 'fia.usuario'

export interface Usuario {
  id: number
  email: string
  nombre: string
}

function leerLS(k: string) {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function escribirLS(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {
    /* sin persistencia */
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(msg)
    this.status = status
  }
}

async function pedir<T>(ruta: string, init: RequestInit = {}): Promise<T> {
  const token = leerLS(K_TOKEN)
  const res = await fetch(`${BASE}/api${ruta}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  const esJson = res.headers.get('content-type')?.includes('json')
  const cuerpo = esJson ? await res.json() : await res.text()
  if (!res.ok) {
    if (res.status === 401) sesion.cerrar()
    const msg = (cuerpo as { error?: string; detalles?: string[] })
    throw new ApiError(res.status, [msg.error, ...(msg.detalles ?? [])].filter(Boolean).join(' · ') || `Error ${res.status}`)
  }
  return cuerpo as T
}

export const sesion = {
  usuario(): Usuario | null {
    const u = leerLS(K_USUARIO)
    return u && leerLS(K_TOKEN) ? (JSON.parse(u) as Usuario) : null
  },
  guardar(token: string, u: Usuario) {
    escribirLS(K_TOKEN, token)
    escribirLS(K_USUARIO, JSON.stringify(u))
  },
  cerrar() {
    escribirLS(K_TOKEN, null)
    escribirLS(K_USUARIO, null)
  },
}

export const api = {
  /** ¿Hay backend disponible? (en GitHub Pages no lo hay: la app trabaja en modo local) */
  async disponible(): Promise<{ ok: boolean; ia: boolean; correo: boolean }> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2500)
      const r = await fetch(`${BASE}/api/salud`, { signal: ctrl.signal })
      clearTimeout(t)
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return { ok: false, ia: false, correo: false }
      const salud = (await r.json()) as { ia?: boolean; correo?: boolean }
      return { ok: true, ia: Boolean(salud.ia), correo: Boolean(salud.correo) }
    } catch {
      return { ok: false, ia: false, correo: false }
    }
  },
  async registro(nombre: string, email: string, password: string) {
    const r = await pedir<{ token: string; usuario: Usuario }>('/auth/registro', {
      method: 'POST',
      body: JSON.stringify({ nombre, email, password }),
    })
    sesion.guardar(r.token, r.usuario)
    return r.usuario
  },
  async login(email: string, password: string) {
    const r = await pedir<{ token: string; usuario: Usuario }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    sesion.guardar(r.token, r.usuario)
    return r.usuario
  },
  ia: (texto: string) =>
    pedir<{ items: ItemSugerido[] }>('/ia', { method: 'POST', body: JSON.stringify({ texto }) }).then((r) => r.items),
  contactoEstado: () =>
    pedir<{ disponible: boolean; turnstileSitio: string | null }>('/contacto/estado').catch(() => ({
      disponible: false,
      turnstileSitio: null,
    })),
  contactoReto: () => pedir<{ reto: string; emitido: number; dificultad: number; firma: string }>('/contacto/reto'),
  contactoWhatsApp: (datos: Record<string, string | number>) =>
    pedir<{ url: string }>('/contacto/whatsapp', { method: 'POST', body: JSON.stringify(datos) }),
  enviarFactura: (numero: string, email: string) =>
    pedir<{ enviado: boolean }>(`/facturas/${encodeURIComponent(numero)}/enviar`, { method: 'POST', body: JSON.stringify({ email }) }),
  emisor: () => pedir<Emisor>('/emisor'),
  emisorPredeterminado: () => pedir<Emisor>('/emisor/predeterminado'),
  guardarEmisor: (e: Emisor) => {
    const { apiKey: _omitida, ...resto } = e // la API key de IA nunca sale del navegador
    return pedir<Emisor>('/emisor', { method: 'PUT', body: JSON.stringify(resto) })
  },
  facturas: () => pedir<Factura[]>('/facturas'),
  emitir: (f: Factura) =>
    pedir<{ factura: Factura }>('/facturas', {
      method: 'POST',
      body: JSON.stringify({
        cliente: f.cliente,
        items: f.items,
        formaPago: f.formaPago,
        medioPago: f.medioPago,
        retefuentePct: f.retefuentePct,
        notas: f.notas,
        vence: f.vence,
      }),
    }).then((r) => r.factura),
  cambiarEstado: (numero: string, estado: 'Pagada' | 'Anulada') =>
    pedir<Factura>(`/facturas/${encodeURIComponent(numero)}/estado`, { method: 'PATCH', body: JSON.stringify({ estado }) }),
}
