import type { Emisor, Factura } from './types'
import { api, sesion } from './api'
import { cadenaCufe, sha384 } from './cufe'
import { calcularTotales } from './calc'
import { store } from './storage'

/**
 * Repositorio: la interfaz no sabe dónde se guardan las facturas.
 *  - Con sesión iniciada → backend (Express + SQLite).
 *  - Sin backend o sin sesión → localStorage del navegador.
 */
export interface Repo {
  modo: 'nube' | 'local'
  historial(): Promise<Factura[]>
  emitir(f: Factura, e: Emisor): Promise<Factura>
  cambiarEstado(numero: string, estado: 'Pagada' | 'Anulada'): Promise<Factura>
  guardarEmisor(e: Emisor): Promise<Emisor>
  cargarEmisor(): Promise<Emisor>
}

export const repoLocal: Repo = {
  modo: 'local',
  historial: async () => store.historial(),
  async emitir(f, e) {
    const emitida: Factura = { ...structuredClone(f), fecha: new Date().toISOString(), estado: 'Pendiente' }
    emitida.cufe = await sha384(cadenaCufe(emitida, calcularTotales(emitida), e))
    store.guardarEnHistorial(emitida)
    return emitida
  },
  async cambiarEstado(numero, estado) {
    const f = store.historial().find((x) => x.numero === numero)
    if (!f) throw new Error('Factura no encontrada')
    if (f.estado !== 'Pendiente') throw new Error(`La factura ya está ${f.estado.toLowerCase()}`)
    f.estado = estado
    store.guardarEnHistorial(f)
    return f
  },
  async guardarEmisor(e) {
    store.guardarEmisor(e)
    return e
  },
  cargarEmisor: async () => store.emisor(),
}

export const repoNube: Repo = {
  modo: 'nube',
  historial: () => api.facturas(),
  emitir: (f) => api.emitir(f),
  cambiarEstado: (n, e) => api.cambiarEstado(n, e),
  async guardarEmisor(e) {
    const guardado = await api.guardarEmisor(e)
    store.guardarEmisor(e) // la API key queda solo en local
    return { ...guardado, apiKey: e.apiKey }
  },
  async cargarEmisor() {
    const remoto = await api.emisor()
    return { ...remoto, apiKey: store.emisor().apiKey }
  },
}

export const repoActual = (): Repo => (sesion.usuario() ? repoNube : repoLocal)
