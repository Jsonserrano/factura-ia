import './style.css'
import QRCode from 'qrcode'
import type { Emisor, Factura, Item, ItemSugerido, IvaPct } from './types'
import { calcularTotales, cop, digitoVerificacion, numeroALetras, totalLinea } from './calc'
import { cadenaCufe, contenidoQR, partesFecha, sha384 } from './cufe'
import { crearDictado, interpretar } from './ai'
import { store } from './storage'
import { generarUBL } from './ubl'
import { api, sesion } from './api'
import { repoActual, type Repo } from './repo'
import { generarPDF } from './pdf'
import {
  descargar,
  dictadoArtefacto,
  enArtefacto,
  enviarConGmail,
  gmailDisponible,
  iaArtefactoDisponible,
  interpretarConArtefacto,
  puedeDescargarXml,
} from './plataforma'

// ------------------------------------------------------------------ estado
let repo: Repo = repoActual()
let emisor: Emisor = store.emisor()
let historial: Factura[] = repo.modo === 'local' ? store.historial() : []
let factura: Factura = store.borrador() ?? nuevaFactura()
let emitida = historial.some((h) => h.numero === factura.numero && !!h.cufe)
let backendDisponible = false
let iaServidor = false
let iaArtefacto = false

function uid() {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)
}

function nuevaFactura(): Factura {
  const consecutivo = historial.reduce((max, f) => Math.max(max, f.consecutivo), 0) + 1
  const vence = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)
  return {
    numero: `${emisor.prefijo}${String(consecutivo).padStart(4, '0')}`,
    consecutivo,
    fecha: new Date().toISOString(),
    vence,
    cliente: { nombre: '', tipoDoc: 'CC', documento: '', email: '', telefono: '', direccion: '' },
    items: [],
    formaPago: 'Contado',
    medioPago: 'Transferencia',
    retefuentePct: 0,
    notas: '',
    estado: 'Pendiente',
  }
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// ------------------------------------------------------------------ layout
document.querySelector<HTMLDivElement>('#app')!.innerHTML = /* html */ `
<header class="topbar">
  <div class="brand">
    <span class="brand-mark">◧</span>
    <div><strong>Factura·IA</strong><small>Facturador de venta · CUFE · QR · WhatsApp</small></div>
  </div>
  <nav>
    <span class="badge modo" id="modo" title="Dónde se guardan tus facturas">Local</span>
    <button class="ghost" data-act="cuenta" id="btn-cuenta" hidden>Iniciar sesión</button>
    <button class="ghost" data-act="historial">Historial</button>
    <button class="ghost" data-act="ajustes">Mi negocio</button>
    <button class="primary" data-act="nueva">+ Nueva factura</button>
  </nav>
</header>

<main class="layout">
  <section class="editor">
    <div class="banner-emitida" hidden>
      <span>🔒 Esta factura ya fue emitida y no se puede modificar.</span>
      <button class="primary sm" data-act="nueva">Nueva factura</button>
      <button class="ghost sm" data-act="duplicar">Duplicar</button>
    </div>

    <fieldset id="form">
      <article class="card ai-card">
        <header>
          <h2>✨ Asistente IA</h2>
          <span class="badge" id="motor">${emisor.apiKey ? 'Claude' : 'IA local'}</span>
        </header>
        <p class="hint">Escribe o dicta la venta como la dirías. Ej: <em>“3 camisetas a 45 mil, 2 gorras 18.500 con 10% de descuento, envío 12000 sin iva”</em></p>
        <div class="ai-box">
          <textarea id="ai-texto" rows="2" placeholder="Describe la venta…"></textarea>
          <button class="icon" id="mic" title="Dictar por voz" aria-label="Dictar por voz">🎙</button>
        </div>
        <div class="row-end">
          <span class="hint" id="ai-estado"></span>
          <button class="primary" id="ai-go">Agregar ítems</button>
        </div>
      </article>

      <article class="card">
        <header><h2>Cliente</h2></header>
        <div class="grid">
          <label class="span2">Nombre o razón social<input data-c="nombre" required placeholder="Ej: Laura Gómez" /></label>
          <label>Tipo doc.
            <select data-c="tipoDoc"><option>CC</option><option>NIT</option><option>CE</option><option>PP</option></select>
          </label>
          <label>Número<input data-c="documento" inputmode="numeric" required placeholder="1098765432" /><small id="dv"></small></label>
          <label>WhatsApp / celular<input data-c="telefono" inputmode="tel" placeholder="300 123 4567" /></label>
          <label>Correo<input data-c="email" type="email" placeholder="cliente@correo.com" /></label>
          <label class="span2">Dirección<input data-c="direccion" placeholder="Opcional" /></label>
        </div>
      </article>

      <article class="card">
        <header><h2>Productos y servicios</h2><button class="ghost sm" id="add-item">+ Agregar línea</button></header>
        <div class="items-head"><span>Descripción</span><span>Cant.</span><span>Precio unit.</span><span>Desc %</span><span>IVA</span><span></span></div>
        <div id="items"></div>
        <p class="empty" id="items-empty">Sin ítems todavía. Usa el asistente o “Agregar línea”.</p>
      </article>

      <article class="card">
        <header><h2>Pago</h2></header>
        <div class="grid">
          <label>Forma de pago<select data-f="formaPago"><option>Contado</option><option>Crédito</option></select></label>
          <label>Medio<select data-f="medioPago"><option>Transferencia</option><option>Efectivo</option><option>Nequi</option><option>Daviplata</option><option>Tarjeta</option></select></label>
          <label>Vencimiento<input type="date" data-f="vence" /></label>
          <label>Retención en la fuente
            <select data-f="retefuentePct"><option value="0">No aplica</option><option value="1">1 %</option><option value="2.5">2,5 %</option><option value="4">4 %</option><option value="11">11 %</option></select>
          </label>
          <label class="span2">Notas<textarea data-f="notas" rows="2" placeholder="Garantía, condiciones, datos de la cuenta…"></textarea></label>
        </div>
      </article>
    </fieldset>
  </section>

  <section class="preview">
    <div class="actions">
      <button class="primary" data-act="emitir" id="btn-emitir">Emitir factura</button>
      <button class="ghost" data-act="pdf" title="Descargar la factura en PDF">⬇ PDF</button>
      <button class="ghost" data-act="correo" title="Enviar PDF y XML al correo del cliente">✉ Correo</button>
      <button class="wa" data-act="wa-cliente">WhatsApp</button>
      <button class="ghost" data-act="xml" title="Ver XML UBL 2.1 (DIAN)">XML</button>
    </div>
    <div id="paper" class="paper"></div>
  </section>
</main>

<button class="wa-float" data-act="contacto" aria-label="Contactar al desarrollador">
  <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M16 3a13 13 0 0 0-11.3 19.4L3 29l6.8-1.8A13 13 0 1 0 16 3zm0 23.7c-2 0-4-.5-5.7-1.6l-.4-.2-4 1 1.1-3.9-.3-.4A10.7 10.7 0 1 1 16 26.7zm5.9-8c-.3-.2-1.9-1-2.2-1s-.5-.2-.7.2l-1 1.2c-.2.2-.4.2-.7 0a8.8 8.8 0 0 1-4.4-3.8c-.3-.6.3-.5.9-1.7.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6 0-.9.4s-1.2 1.1-1.2 2.8 1.2 3.2 1.4 3.5c.2.2 2.4 3.6 5.8 5 2.1.9 3 1 4 .8.7-.1 1.9-.8 2.2-1.5s.3-1.4.2-1.5l-.6-.4z"/></svg>
  <span>Escríbeme</span>
</button>

<dialog id="dlg-ajustes">
  <form method="dialog" class="dlg">
    <h2>Mi negocio</h2>
    <p class="hint">Estos datos salen en el encabezado de la factura y se guardan en este navegador.</p>
    <div class="grid">
      <label class="span2">Razón social<input name="razonSocial" /></label>
      <label>NIT (sin DV)<input name="nit" inputmode="numeric" /></label>
      <label>Prefijo<input name="prefijo" maxlength="4" /></label>
      <label class="span2">Dirección<input name="direccion" /></label>
      <label>Ciudad<input name="ciudad" /></label>
      <label>Correo<input name="email" type="email" /></label>
      <label class="span2">Mi WhatsApp (con indicativo, solo números)<input name="whatsapp" inputmode="tel" placeholder="573001234567" /></label>
      <label class="span2">Resolución de facturación<input name="resolucion" /></label>
      <label class="span2">Clave técnica (CUFE)<input name="claveTecnica" /></label>
      <label class="span2">Claude API key <small>(opcional · activa la IA avanzada · se guarda solo en tu navegador)</small><input name="apiKey" type="password" placeholder="sk-ant-…" autocomplete="off" /></label>
    </div>
    <div class="row-end"><button value="cancel" class="ghost">Cancelar</button><button value="ok" class="primary">Guardar</button></div>
  </form>
</dialog>

<dialog id="dlg-historial">
  <div class="dlg">
    <header class="row-between"><h2>Historial</h2><button class="ghost sm" data-close>Cerrar</button></header>
    <div class="kpis" id="kpis"></div>
    <div id="lista-historial"></div>
  </div>
</dialog>

<dialog id="dlg-cuenta">
  <form class="dlg" id="form-cuenta">
    <header class="row-between"><h2 id="cuenta-titulo">Iniciar sesión</h2><button type="button" class="ghost sm" data-close-cuenta>Cerrar</button></header>
    <p class="hint">Con una cuenta tus facturas se guardan en el servidor (Express + SQLite) y las ves desde cualquier dispositivo.</p>
    <div class="tabs"><button type="button" class="tab on" data-tab="login">Entrar</button><button type="button" class="tab" data-tab="registro">Crear cuenta</button></div>
    <div class="grid">
      <label class="span2" id="campo-nombre" hidden>Nombre<input name="nombre" autocomplete="name" /></label>
      <label class="span2">Correo<input name="email" type="email" required autocomplete="email" /></label>
      <label class="span2">Contraseña<input name="password" type="password" required minlength="8" autocomplete="current-password" /></label>
    </div>
    <p class="error" id="cuenta-error" role="alert"></p>
    <div class="row-end"><button class="primary" id="cuenta-ok">Entrar</button></div>
  </form>
</dialog>

<dialog id="dlg-xml" class="ancho">
  <div class="dlg">
    <header class="row-between"><h2>XML UBL 2.1 · DIAN</h2><div class="row-gap"><button class="ghost sm" id="xml-copiar">Copiar</button><button class="ghost sm" id="xml-descargar">Descargar</button><button class="ghost sm" data-close-xml>Cerrar</button></div></header>
    <p class="hint">Estructura de factura electrónica de venta (perfil DIAN 2.1). Sin firma digital: para producción se firma con certificado XAdES y se envía a la DIAN.</p>
    <pre id="xml-codigo"></pre>
  </div>
</dialog>

<dialog id="dlg-contacto">
  <div class="dlg">
    <header class="row-between"><h2>Escríbeme por WhatsApp</h2><button type="button" class="ghost sm" data-close-contacto>Cerrar</button></header>
    <section id="ct-estado">
      <p class="ok-msg" id="ct-titulo">Verificando que eres una persona…</p>
      <p class="hint" id="ct-detalle">Esto evita que los bots obtengan mi número. Tarda un segundo.</p>
      <a class="wa btn grande" id="ct-abrir" href="#" target="_blank" rel="noopener" hidden>Abrir WhatsApp</a>
    </section>
    <section id="ct-sin-servidor" hidden>
      <p class="hint">El botón directo a WhatsApp funciona en la app en vivo, donde mi número está protegido en el servidor.</p>
      <a class="primary btn grande" id="ct-app" href="#" target="_blank" rel="noopener">Abrir la app en vivo</a>
      <p class="hint" style="margin-top:12px">Mientras tanto puedes ver el código en <a href="https://github.com/Jsonserrano" target="_blank" rel="noopener">github.com/Jsonserrano</a>.</p>
    </section>
    <p class="error" id="ct-error" role="alert"></p>
    <div id="ct-turnstile"></div>
  </div>
</dialog>

<dialog id="dlg-correo">
  <form class="dlg" id="form-correo">
    <header class="row-between"><h2>Enviar factura por correo</h2><button type="button" class="ghost sm" data-close-correo>Cerrar</button></header>
    <p class="hint" id="correo-via"></p>
    <label>Correo del cliente<input name="email" type="email" required placeholder="cliente@correo.com" /></label>
    <p class="hint" style="margin-top:10px">Se adjuntan el <b>PDF</b> y el <b>XML UBL 2.1</b> de la factura.</p>
    <p class="error" id="correo-error" role="alert"></p>
    <div class="row-end"><button class="primary" id="correo-ok">Enviar</button></div>
  </form>
</dialog>

<dialog id="dlg-wa">
  <div class="dlg">
    <header class="row-between"><h2 id="wa-titulo">WhatsApp</h2><button type="button" class="ghost sm" data-close-wa>Cerrar</button></header>
    <div class="wa-opciones">
      <img id="wa-qr" alt="Código QR para abrir el chat de WhatsApp" width="180" height="180" />
      <div>
        <p class="hint"><b>Desde el celular:</b> escanea este código con la cámara y se abre el chat con el mensaje listo.</p>
        <p class="hint"><b>Desde el computador:</b></p>
        <div class="wa-botones">
          <a class="wa btn" id="wa-app" href="#">App de WhatsApp</a>
          <a class="ghost btn" id="wa-web" href="#" target="_blank" rel="noopener">WhatsApp Web</a>
        </div>
        <p class="hint mini">WhatsApp Web pide escanear su propio QR la primera vez que lo usas en un navegador.</p>
      </div>
    </div>
  </div>
</dialog>

<div class="toast" id="toast" role="status"></div>
`

// ------------------------------------------------------------------ helpers UI
function toast(msg: string) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout((t as unknown as { _t: number })._t)
  ;(t as unknown as { _t: number })._t = window.setTimeout(() => t.classList.remove('show'), 2600)
}

function persistir() {
  if (!emitida) store.guardarBorrador(factura)
}

function cargarFormulario() {
  document.querySelectorAll<HTMLInputElement>('[data-c]').forEach((el) => {
    el.value = String(factura.cliente[el.dataset.c as keyof Factura['cliente']] ?? '')
  })
  document.querySelectorAll<HTMLInputElement>('[data-f]').forEach((el) => {
    el.value = String(factura[el.dataset.f as keyof Factura] ?? '')
  })
  renderItems()
  bloquear()
  actualizarDV()
}

function bloquear() {
  ;($('#form') as HTMLFieldSetElement).disabled = emitida
  $('.banner-emitida').hidden = !emitida
  $('#btn-emitir').textContent = emitida ? 'Emitida ✓' : 'Emitir factura'
  ;($('#btn-emitir') as HTMLButtonElement).disabled = emitida
}

function actualizarDV() {
  const dv = $('#dv')
  if (factura.cliente.tipoDoc === 'NIT' && factura.cliente.documento) {
    const d = digitoVerificacion(factura.cliente.documento)
    dv.textContent = d === null ? '' : `DV: ${d}`
  } else dv.textContent = ''
}

// ------------------------------------------------------------------ ítems
function filaItem(it: Item) {
  return /* html */ `
  <div class="item" data-id="${it.id}">
    <input data-k="descripcion" value="${esc(it.descripcion)}" placeholder="Descripción" aria-label="Descripción" />
    <input data-k="cantidad" type="number" min="0" step="any" value="${it.cantidad}" aria-label="Cantidad" />
    <input data-k="precio" type="number" min="0" step="any" value="${it.precio}" aria-label="Precio unitario" />
    <input data-k="descuentoPct" type="number" min="0" max="100" step="any" value="${it.descuentoPct}" aria-label="Descuento %" />
    <select data-k="ivaPct" aria-label="IVA">
      ${[19, 5, 0].map((v) => `<option value="${v}" ${v === it.ivaPct ? 'selected' : ''}>${v}%</option>`).join('')}
    </select>
    <button class="icon del" data-del title="Quitar" aria-label="Quitar">✕</button>
    <span class="item-total">${cop.format(totalLinea(it).total)}</span>
  </div>`
}

function renderItems() {
  $('#items').innerHTML = factura.items.map(filaItem).join('')
  $('#items-empty').hidden = factura.items.length > 0
}

function agregarItems(sug: ItemSugerido[]) {
  factura.items.push(...sug.map((s) => ({ ...s, id: uid() })))
  renderItems()
  refrescar()
}

$('#add-item').addEventListener('click', (e) => {
  e.preventDefault()
  agregarItems([{ descripcion: '', cantidad: 1, precio: 0, descuentoPct: 0, ivaPct: 19 }])
  const filas = document.querySelectorAll<HTMLInputElement>('.item [data-k="descripcion"]')
  filas[filas.length - 1]?.focus()
})

$('#items').addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement
  const fila = el.closest<HTMLElement>('.item')
  const it = factura.items.find((i) => i.id === fila?.dataset.id)
  if (!it || !el.dataset.k) return
  const k = el.dataset.k as keyof Item
  if (k === 'descripcion') it.descripcion = el.value
  else if (k === 'ivaPct') it.ivaPct = Number(el.value) as IvaPct
  else (it[k] as number) = Math.max(0, Number(el.value) || 0)
  $('.item-total', fila!).textContent = cop.format(totalLinea(it).total)
  refrescar()
})

$('#items').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-del]')
  if (!btn) return
  e.preventDefault()
  const id = btn.closest<HTMLElement>('.item')?.dataset.id
  factura.items = factura.items.filter((i) => i.id !== id)
  renderItems()
  refrescar()
})

// ------------------------------------------------------------------ cliente / pago
document.querySelectorAll<HTMLInputElement>('[data-c]').forEach((el) =>
  el.addEventListener('input', () => {
    ;(factura.cliente as unknown as Record<string, string>)[el.dataset.c!] = el.value
    actualizarDV()
    refrescar()
  }),
)
document.querySelectorAll<HTMLInputElement>('[data-f]').forEach((el) =>
  el.addEventListener('input', () => {
    const k = el.dataset.f as keyof Factura
    ;(factura as unknown as Record<string, unknown>)[k] = k === 'retefuentePct' ? Number(el.value) : el.value
    refrescar()
  }),
)

// ------------------------------------------------------------------ IA
$('#ai-go').addEventListener('click', async (e) => {
  e.preventDefault()
  const txt = ($('#ai-texto') as HTMLTextAreaElement).value.trim()
  if (!txt) return toast('Escribe o dicta la venta primero')
  const btn = e.currentTarget as HTMLButtonElement
  btn.disabled = true
  $('#ai-estado').textContent = 'Interpretando…'
  try {
    const { items, motor } = await interpretar(txt, emisor.apiKey, iaServidor ? api.ia : iaArtefacto ? interpretarConArtefacto : undefined)
    if (!items.length) {
      $('#ai-estado').textContent = 'No encontré productos. Prueba: “2 almuerzos a 18 mil”.'
      return
    }
    agregarItems(items)
    ;($('#ai-texto') as HTMLTextAreaElement).value = ''
    $('#ai-estado').textContent = `${items.length} ítem(s) agregados con ${motor === 'Claude' ? 'Claude' : 'IA local'} · revisa precios e IVA`
  } finally {
    btn.disabled = false
  }
})
$('#ai-texto').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter' && !(e as KeyboardEvent).shiftKey) {
    e.preventDefault()
    $('#ai-go').click()
  }
})

const dictado = enArtefacto() ? null : crearDictado()
if (!dictado) $('#mic').hidden = true
if (enArtefacto()) {
  // En el visor de Claude el micrófono va por su capacidad de dictado
  void dictadoArtefacto().then((d) => {
    if (!d) return
    $('#mic').hidden = false
    let activo = false
    d.onFinal(({ text }) => {
      const ta = $('#ai-texto') as HTMLTextAreaElement
      ta.value = (ta.value ? ta.value + ', ' : '') + text
    })
    d.onState(({ state }) => {
      activo = state === 'listening'
      $('#mic').classList.toggle('rec', activo)
    })
    $('#mic').addEventListener('click', (e) => {
      e.preventDefault()
      if (activo) void d.stop()
      else d.start().catch(() => toast('No se pudo activar el dictado'))
    })
  })
} else if (dictado) {
  let escuchando = false
  dictado.onresult = (e) => {
    const t = Array.from(e.results).map((r) => r[0].transcript).join(' ')
    const ta = $('#ai-texto') as HTMLTextAreaElement
    ta.value = (ta.value ? ta.value + ', ' : '') + t
  }
  dictado.onerror = (e) => toast(e.error === 'not-allowed' ? 'Permite el micrófono para dictar' : 'No se pudo escuchar')
  dictado.onend = () => {
    escuchando = false
    $('#mic').classList.remove('rec')
  }
  $('#mic').addEventListener('click', (e) => {
    e.preventDefault()
    if (escuchando) return dictado.stop()
    escuchando = true
    $('#mic').classList.add('rec')
    dictado.start()
  })
}

// ------------------------------------------------------------------ vista previa
let renderToken = 0
let timer = 0
function refrescar() {
  persistir()
  clearTimeout(timer)
  timer = window.setTimeout(renderPaper, 120)
}

async function renderPaper() {
  const token = ++renderToken
  const t = calcularTotales(factura)
  const cufe = factura.cufe ?? (await sha384(cadenaCufe(factura, t, emisor)))
  const qr = await qrNitido(contenidoQR(factura, t, emisor, cufe))
  if (token !== renderToken) return // llegó un render más nuevo
  const { fecha, hora } = partesFecha(factura.fecha)
  const c = factura.cliente
  const dvEmisor = digitoVerificacion(emisor.nit)
  const dvCliente = c.tipoDoc === 'NIT' ? digitoVerificacion(c.documento) : null

  $('#paper').innerHTML = /* html */ `
  ${emitida ? `<div class="stamp ${factura.estado === 'Anulada' ? 'void' : ''}">${factura.estado === 'Pendiente' ? 'Emitida' : factura.estado}</div>` : '<div class="stamp draft">Borrador</div>'}
  <header class="p-head">
    <div>
      <h1>${esc(emisor.razonSocial)}</h1>
      <p>NIT ${esc(emisor.nit)}${dvEmisor !== null ? `-${dvEmisor}` : ''} · Responsable de IVA</p>
      <p>${esc(emisor.direccion)} · ${esc(emisor.ciudad)}</p>
      <p>${esc(emisor.email)}${emisor.whatsapp ? ` · WhatsApp ${esc(formatoTel(emisor.whatsapp))}` : ''}</p>
    </div>
    <div class="p-num">
      <span>Factura electrónica de venta</span>
      <strong>${esc(factura.numero)}</strong>
      <small>${fecha} · ${hora.slice(0, 5)}</small>
    </div>
  </header>

  <section class="p-parties">
    <div>
      <h3>Facturar a</h3>
      <p class="big">${c.nombre ? esc(c.nombre) : '<span class="ph">Nombre del cliente</span>'}</p>
      <p>${c.tipoDoc} ${c.documento ? esc(c.documento) : '—'}${dvCliente !== null ? `-${dvCliente}` : ''}</p>
      ${c.direccion ? `<p>${esc(c.direccion)}</p>` : ''}
      ${c.email || c.telefono ? `<p>${esc([c.email, c.telefono].filter(Boolean).join(' · '))}</p>` : ''}
    </div>
    <div class="p-meta">
      <div><span>Forma de pago</span><b>${factura.formaPago}</b></div>
      <div><span>Medio</span><b>${factura.medioPago}</b></div>
      <div><span>Vence</span><b>${factura.formaPago === 'Contado' ? fecha : factura.vence}</b></div>
    </div>
  </section>

  <table class="p-items">
    <thead><tr><th>#</th><th>Descripción</th><th>Cant.</th><th>V. unit.</th><th>Desc.</th><th>IVA</th><th>Total</th></tr></thead>
    <tbody>
      ${
        factura.items.length
          ? factura.items
              .map((it, i) => {
                const l = totalLinea(it)
                return `<tr><td>${i + 1}</td><td>${esc(it.descripcion || '—')}</td><td>${it.cantidad}</td><td>${cop.format(it.precio)}</td><td>${it.descuentoPct ? it.descuentoPct + '%' : '—'}</td><td>${it.ivaPct}%</td><td>${cop.format(l.total)}</td></tr>`
              })
              .join('')
          : '<tr><td colspan="7" class="ph center">Los ítems aparecerán aquí</td></tr>'
      }
    </tbody>
  </table>

  <section class="p-bottom">
    <div class="p-qr">
      <img src="${qr}" alt="Código QR de la factura" class="qr" width="210" height="210" />
      <div>
        <h3>CUFE</h3>
        <code>${cufe}</code>
        <p>Escanea el QR con la cámara para consultar la factura en la DIAN.</p>
      </div>
    </div>
    <dl class="p-totals">
      <div><dt>Subtotal bruto</dt><dd>${cop.format(t.bruto)}</dd></div>
      ${t.descuentos ? `<div><dt>Descuentos</dt><dd>− ${cop.format(t.descuentos)}</dd></div>` : ''}
      <div><dt>Base gravable</dt><dd>${cop.format(t.subtotal)}</dd></div>
      ${([19, 5] as IvaPct[])
        .filter((k) => t.ivaPorTarifa[k].impuesto)
        .map((k) => `<div><dt>IVA ${k}%</dt><dd>${cop.format(t.ivaPorTarifa[k].impuesto)}</dd></div>`)
        .join('')}
      <div class="grand"><dt>Total</dt><dd>${cop.format(t.total)}</dd></div>
      ${
        t.retefuente
          ? `<div><dt>Retefuente ${String(factura.retefuentePct).replace('.', ',')} %</dt><dd>− ${cop.format(t.retefuente)}</dd></div>
             <div class="neto"><dt>Neto a pagar</dt><dd>${cop.format(t.netoPagar)}</dd></div>`
          : ''
      }
    </dl>
  </section>

  <p class="p-letras">Son: <b>${numeroALetras(t.netoPagar)}</b></p>
  ${factura.notas ? `<p class="p-notas">${esc(factura.notas)}</p>` : ''}

  <footer class="p-foot">
    <p>${esc(emisor.resolucion)}</p>
    <p>Representación gráfica generada en ambiente de pruebas (TipoAmbiente 2) · No transmitida a la DIAN · Sin validez fiscal</p>
  </footer>`
}

// ------------------------------------------------------------------ validación y emisión
function validar(): string | null {
  if (!factura.cliente.nombre.trim()) return 'Falta el nombre del cliente'
  if (!/\d{5,}/.test(factura.cliente.documento)) return 'El documento del cliente no es válido'
  if (!factura.items.length) return 'Agrega al menos un ítem'
  const malo = factura.items.find((i) => !i.descripcion.trim() || i.cantidad <= 0 || i.precio <= 0)
  if (malo) return 'Revisa los ítems: todos necesitan descripción, cantidad y precio'
  return null
}

async function emitir() {
  const err = validar()
  if (err) return toast(err)
  const btn = $('#btn-emitir') as HTMLButtonElement
  btn.disabled = true
  try {
    // En modo nube el servidor asigna consecutivo, fecha y CUFE (fuente de verdad)
    factura = await repo.emitir(factura, emisor)
    historial = [factura, ...historial.filter((h) => h.numero !== factura.numero)]
    emitida = true
    cargarFormulario()
    await renderPaper()
    toast(`${factura.numero} emitida ✓${repo.modo === 'nube' ? ' · guardada en la nube' : ''}`)
  } catch (e) {
    btn.disabled = false
    toast(e instanceof Error ? e.message : 'No se pudo emitir')
  }
}

/** 573001234567 → +57 300 123 4567 */
function formatoTel(d: string) {
  const m = d.match(/^57(\d{3})(\d{3})(\d{4})$/)
  return m ? `+57 ${m[1]} ${m[2]} ${m[3]}` : `+${d}`
}

function telefonoWa(raw: string) {
  const d = raw.replace(/\D/g, '')
  if (d.length === 10 && d.startsWith('3')) return '57' + d // celular colombiano
  return d
}

function mensajeWhatsApp() {
  const t = calcularTotales(factura)
  const lineas = factura.items.map((i) => `• ${i.cantidad} × ${i.descripcion} — ${cop.format(totalLinea(i).total)}`)
  return [
    `Hola ${factura.cliente.nombre.split(' ')[0] || ''} 👋`,
    `Te comparto tu factura *${factura.numero}* de *${emisor.razonSocial}*:`,
    '',
    ...lineas,
    '',
    `*Total a pagar: ${cop.format(t.netoPagar)}*`,
    `Medio de pago: ${factura.medioPago}${factura.formaPago === 'Crédito' ? ` · vence ${factura.vence}` : ''}`,
    factura.cufe ? `CUFE: ${factura.cufe.slice(0, 16)}…` : '',
    '',
    '¡Gracias por tu compra!',
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n')
}

// ------------------------------------------------------------------ WhatsApp (QR + app + web)
/** Abre el diálogo con tres caminos: QR para el celular, app de escritorio y WhatsApp Web. */
/**
 * QR que la cámara del celular sí lee: borde blanco de 4 módulos (zona de silencio),
 * negro puro sobre blanco y generado grande para que no se vea borroso.
 */
async function qrNitido(contenido: string, nivel: 'L' | 'M' = 'L') {
  return QRCode.toDataURL(contenido, {
    margin: 4,
    width: 640,
    errorCorrectionLevel: nivel,
    color: { dark: '#000000', light: '#ffffff' },
  })
}

/**
 * `mensaje` (completo) va en los botones de app y web.
 * `mensajeQR` (corto, sin emojis) va en el QR: menos datos = QR menos denso y fácil de escanear.
 */
async function abrirWhatsApp(titulo: string, telefono: string, mensaje: string, mensajeQR = mensaje) {
  const txt = encodeURIComponent(mensaje)
  $('#wa-titulo').textContent = titulo
  $('#wa-app').setAttribute('href', `whatsapp://send?phone=${telefono}&text=${txt}`)
  $('#wa-web').setAttribute('href', `https://web.whatsapp.com/send?phone=${telefono}&text=${txt}`)
  const img = $('#wa-qr') as HTMLImageElement
  try {
    img.src = await qrNitido(`https://wa.me/${telefono}?text=${encodeURIComponent(mensajeQR.slice(0, 300))}`, 'M')
  } catch {
    img.src = await qrNitido(`https://wa.me/${telefono}`, 'M') // respaldo: abre el chat sin texto
  }
  ;($('#dlg-wa') as HTMLDialogElement).showModal()
}
$('[data-close-wa]').addEventListener('click', () => ($('#dlg-wa') as HTMLDialogElement).close())

// ------------------------------------------------------------------ PDF y correo
const base64 = (bytes: Uint8Array) => {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function pdfActual() {
  const t = calcularTotales(factura)
  const cufe = factura.cufe ?? (await sha384(cadenaCufe(factura, t, emisor)))
  const url = await qrNitido(contenidoQR(factura, t, emisor, cufe))
  const qr = Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0))
  return { pdf: await generarPDF(factura, t, emisor, cufe, qr), t, cufe }
}

async function descargarPDF() {
  if (!factura.items.length) return toast('Agrega ítems antes de descargar')
  try {
    const { pdf } = await pdfActual()
    const r = await descargar(`${factura.numero}.pdf`, pdf, 'application/pdf')
    if (r === 'ok') toast(`${factura.numero}.pdf descargado`)
  } catch (e) {
    toast(e instanceof Error ? e.message : 'No se pudo generar el PDF')
  }
}

type ViaCorreo = 'servidor' | 'gmail' | 'login' | 'ninguna'
let correoServidor = false
let gmailArtefacto = false
function viaCorreo(): ViaCorreo {
  if (repo.modo === 'nube' && correoServidor) return 'servidor'
  if (gmailArtefacto) return 'gmail'
  if (backendDisponible && correoServidor) return 'login'
  return 'ninguna'
}

function abrirCorreo() {
  if (!emitida) return toast('Primero emite la factura')
  const via = viaCorreo()
  if (via === 'login') {
    toast('Inicia sesión para enviar facturas por correo')
    ;($('#dlg-cuenta') as HTMLDialogElement).showModal()
    return
  }
  const textos: Record<ViaCorreo, string> = {
    servidor: 'Se envía desde el servidor de Factura·IA (Brevo).',
    gmail: 'Se envía desde tu cuenta de Gmail conectada a Claude. La primera vez te pedirá permiso.',
    login: '',
    ninguna:
      'El envío por correo funciona en la app en vivo (con cuenta) o en esta demo dentro de Claude con Gmail conectado.',
  }
  $('#correo-via').textContent = textos[via]
  ;($('#correo-ok') as HTMLButtonElement).disabled = via === 'ninguna'
  ;($('#form-correo [name="email"]') as HTMLInputElement).value = factura.cliente.email
  $('#correo-error').textContent = ''
  ;($('#dlg-correo') as HTMLDialogElement).showModal()
}
$('[data-close-correo]').addEventListener('click', () => ($('#dlg-correo') as HTMLDialogElement).close())
$('#form-correo').addEventListener('submit', async (e) => {
  e.preventDefault()
  const para = ($('#form-correo [name="email"]') as HTMLInputElement).value.trim()
  const btn = $('#correo-ok') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = 'Enviando…'
  $('#correo-error').textContent = ''
  try {
    if (viaCorreo() === 'servidor') {
      await api.enviarFactura(factura.numero, para)
    } else {
      const { pdf, t, cufe } = await pdfActual()
      const xml = generarUBL(factura, t, emisor, cufe)
      await enviarConGmail({
        para,
        asunto: `Factura electrónica ${factura.numero} de ${emisor.razonSocial}`,
        html: `<p>Hola ${esc(factura.cliente.nombre)},</p><p>Adjuntamos tu factura electrónica <b>${esc(factura.numero)}</b> (PDF y XML UBL 2.1).</p><p><b>Total a pagar: ${cop.format(t.netoPagar)}</b></p><p style="color:#777;font-size:12px">CUFE: ${cufe}<br>Documento de prueba, sin validez fiscal.</p>`,
        adjuntos: [
          { nombre: `${factura.numero}.pdf`, base64: base64(pdf), mime: 'application/pdf' },
          { nombre: `${factura.numero}.xml`, base64: base64(new TextEncoder().encode(xml)), mime: 'application/xml' },
        ],
      })
    }
    ;($('#dlg-correo') as HTMLDialogElement).close()
    toast(`Factura enviada a ${para} ✓`)
  } catch (err) {
    $('#correo-error').textContent = err instanceof Error ? err.message : 'No se pudo enviar'
  } finally {
    btn.disabled = false
    btn.textContent = 'Enviar'
  }
})

// ------------------------------------------------------------------ acciones globales
document.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
  if (!el) return
  switch (el.dataset.act) {
    case 'nueva':
      factura = nuevaFactura()
      emitida = false
      persistir()
      cargarFormulario()
      refrescar()
      ;($('[data-c="nombre"]') as HTMLInputElement).focus()
      break
    case 'duplicar': {
      const items = factura.items.map((i) => ({ ...i, id: uid() }))
      const cliente = { ...factura.cliente }
      factura = { ...nuevaFactura(), items, cliente }
      emitida = false
      persistir()
      cargarFormulario()
      refrescar()
      toast('Copia creada como nueva factura')
      break
    }
    case 'emitir':
      await emitir()
      break
    case 'pdf':
      await descargarPDF()
      break
    case 'correo':
      abrirCorreo()
      break
    case 'wa-cliente': {
      const tel = telefonoWa(factura.cliente.telefono)
      if (tel.length < 10) {
        toast('Agrega el celular del cliente')
        ;($('[data-c="telefono"]') as HTMLInputElement).focus()
        break
      }
      const corto = `Hola ${factura.cliente.nombre.split(' ')[0]}, te envío la factura ${factura.numero} de ${emisor.razonSocial}. Total a pagar: ${cop.format(calcularTotales(factura).netoPagar)}.`
      await abrirWhatsApp(`Enviar ${factura.numero} por WhatsApp`, tel, mensajeWhatsApp(), corto)
      break
    }
    case 'contacto':
      void abrirContacto()
      break
    case 'xml':
      await abrirXML()
      break
    case 'ajustes':
      abrirAjustes()
      break
    case 'historial':
      await abrirHistorial()
      break
    case 'cuenta':
      if (sesion.usuario()) cerrarSesion()
      else ($('#dlg-cuenta') as HTMLDialogElement).showModal()
      break
  }
})

// ------------------------------------------------------------------ XML UBL
let xmlActual = ''
async function abrirXML() {
  const t = calcularTotales(factura)
  const cufe = factura.cufe ?? (await sha384(cadenaCufe(factura, t, emisor)))
  xmlActual = generarUBL(factura, t, emisor, cufe)
  $('#xml-codigo').textContent = xmlActual
  ;($('#dlg-xml') as HTMLDialogElement).showModal()
}
$('#xml-copiar').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(xmlActual)
    toast('XML copiado')
  } catch {
    toast('No se pudo copiar: selecciónalo manualmente')
  }
})
$('#xml-descargar').addEventListener('click', () => descargar(`${factura.numero}.xml`, xmlActual, 'application/xml'))
if (!puedeDescargarXml()) $('#xml-descargar').hidden = true
$('[data-close-xml]').addEventListener('click', () => ($('#dlg-xml') as HTMLDialogElement).close())

// ------------------------------------------------------------------ ajustes
function abrirAjustes() {
  const dlg = $('#dlg-ajustes') as HTMLDialogElement
  const form = $('form', dlg) as HTMLFormElement
  for (const [k, v] of Object.entries(emisor)) {
    const inp = form.elements.namedItem(k) as HTMLInputElement | null
    if (inp) inp.value = v
  }
  dlg.showModal()
}
$('#dlg-ajustes').addEventListener('close', async () => {
  const dlg = $('#dlg-ajustes') as HTMLDialogElement
  if (dlg.returnValue !== 'ok') return
  const data = Object.fromEntries(new FormData($('form', dlg) as HTMLFormElement)) as unknown as Emisor
  data.whatsapp = telefonoWa(data.whatsapp)
  try {
    emisor = await repo.guardarEmisor({ ...emisor, ...data })
    toast('Datos del negocio guardados')
  } catch (e) {
    toast(e instanceof Error ? e.message : 'No se pudo guardar')
  }
  $('#motor').textContent = emisor.apiKey || iaServidor ? 'Claude' : 'IA local'
  if (!emitida) factura.numero = `${emisor.prefijo}${String(factura.consecutivo).padStart(4, '0')}`
  refrescar()
})

// ------------------------------------------------------------------ historial
async function abrirHistorial() {
  try {
    historial = await repo.historial()
  } catch (e) {
    toast(e instanceof Error ? e.message : 'No se pudo cargar el historial')
  }
  const h = historial
  const vivas = h.filter((f) => f.estado !== 'Anulada')
  const suma = (arr: Factura[]) => arr.reduce((s, f) => s + calcularTotales(f).netoPagar, 0)
  $('#kpis').innerHTML = `
    <div><span>Facturado</span><b>${cop.format(suma(vivas))}</b></div>
    <div><span>Por cobrar</span><b>${cop.format(suma(vivas.filter((f) => f.estado === 'Pendiente')))}</b></div>
    <div><span>Facturas</span><b>${h.length}</b></div>`
  $('#lista-historial').innerHTML = h.length
    ? h
        .map(
          (f) => `
      <div class="h-row" data-num="${esc(f.numero)}">
        <div><b>${esc(f.numero)}</b><small>${esc(f.cliente.nombre)} · ${partesFecha(f.fecha).fecha}</small></div>
        <span class="pill ${f.estado.toLowerCase()}">${f.estado}</span>
        <b class="money">${cop.format(calcularTotales(f).netoPagar)}</b>
        <div class="h-actions">
          <button class="ghost sm" data-h="ver">Ver</button>
          ${f.estado === 'Pendiente' ? '<button class="ghost sm" data-h="pagada">Marcar pagada</button><button class="ghost sm danger" data-h="anular">Anular</button>' : ''}
        </div>
      </div>`,
        )
        .join('')
    : '<p class="empty">Aún no has emitido facturas.</p>'
  const dlg = $('#dlg-historial') as HTMLDialogElement
  if (!dlg.open) dlg.showModal()
}
$('#dlg-historial').addEventListener('click', async (e) => {
  const dlg = e.currentTarget as HTMLDialogElement
  const t = e.target as HTMLElement
  if (t === dlg || t.closest('[data-close]')) return dlg.close()
  const btn = t.closest<HTMLElement>('[data-h]')
  if (!btn) return
  const num = btn.closest<HTMLElement>('.h-row')!.dataset.num!
  const f = historial.find((x) => x.numero === num)
  if (!f) return
  if (btn.dataset.h === 'ver') {
    factura = structuredClone(f)
    emitida = true
    cargarFormulario()
    refrescar()
    dlg.close()
    return
  }
  if (btn.dataset.h === 'anular') {
    // confirmación en dos pasos (sin confirm(), que se bloquea en iframes)
    btn.dataset.h = 'anular-ok'
    btn.textContent = '¿Seguro? Anular'
    return
  }
  try {
    const nueva = await repo.cambiarEstado(num, btn.dataset.h === 'pagada' ? 'Pagada' : 'Anulada')
    if (factura.numero === num) {
      factura = { ...factura, estado: nueva.estado }
      refrescar()
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : 'No se pudo actualizar')
  }
  await abrirHistorial()
})

// ------------------------------------------------------------------ cuenta (backend)
let modoRegistro = false
function pintarCuenta() {
  const u = sesion.usuario()
  const btn = $('#btn-cuenta')
  btn.hidden = !backendDisponible
  btn.textContent = u ? `Salir (${u.nombre.split(' ')[0]})` : 'Iniciar sesión'
  $('#modo').textContent = repo.modo === 'nube' ? '☁ Nube' : 'Local'
  $('#modo').classList.toggle('nube', repo.modo === 'nube')
}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    modoRegistro = b.dataset.tab === 'registro'
    document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b))
    $('#campo-nombre').hidden = !modoRegistro
    ;($('[name="nombre"]') as HTMLInputElement).required = modoRegistro
    $('#cuenta-titulo').textContent = modoRegistro ? 'Crear cuenta' : 'Iniciar sesión'
    $('#cuenta-ok').textContent = modoRegistro ? 'Crear cuenta' : 'Entrar'
    $('#cuenta-error').textContent = ''
  }),
)
$('[data-close-cuenta]').addEventListener('click', () => ($('#dlg-cuenta') as HTMLDialogElement).close())
$('#form-cuenta').addEventListener('submit', async (e) => {
  e.preventDefault()
  const d = Object.fromEntries(new FormData(e.target as HTMLFormElement)) as Record<string, string>
  const ok = $('#cuenta-ok') as HTMLButtonElement
  ok.disabled = true
  $('#cuenta-error').textContent = ''
  try {
    const u = modoRegistro ? await api.registro(d.nombre, d.email, d.password) : await api.login(d.email, d.password)
    ;($('#dlg-cuenta') as HTMLDialogElement).close()
    await cambiarRepo()
    if (modoRegistro) await repo.guardarEmisor(emisor).catch(() => undefined) // sube los datos del negocio actuales
    toast(`Hola, ${u.nombre.split(' ')[0]} 👋`)
  } catch (err) {
    $('#cuenta-error').textContent = err instanceof Error ? err.message : 'Error'
  } finally {
    ok.disabled = false
  }
})

function cerrarSesion() {
  sesion.cerrar()
  void cambiarRepo()
  toast('Sesión cerrada · modo local')
}

async function cambiarRepo() {
  repo = repoActual()
  try {
    emisor = await repo.cargarEmisor()
    historial = await repo.historial()
  } catch (e) {
    toast(e instanceof Error ? e.message : 'No se pudo conectar')
  }
  if (!emitida) {
    factura.consecutivo = historial.reduce((m, f) => Math.max(m, f.consecutivo), 0) + 1
    factura.numero = `${emisor.prefijo}${String(factura.consecutivo).padStart(4, '0')}`
  }
  pintarCuenta()
  refrescar()
}

// ------------------------------------------------------------------ WhatsApp directo (solo humanos)
// Se define al desplegar (VITE_APP_URL). Sin valor, no se enlaza a ninguna app externa.
const APP_EN_VIVO = (import.meta.env?.VITE_APP_URL as string | undefined) ?? ''
let contactoDisponible = false
let turnstileSitio: string | null = null
let turnstileToken = ''
const cargaPagina = performance.now()
let interacciones = 0
for (const ev of ['pointermove', 'pointerdown', 'touchstart', 'keydown', 'wheel'] as const)
  window.addEventListener(ev, (e) => e.isTrusted && interacciones++, { passive: true })

/** Prueba de trabajo: busca un número cuyo SHA-256 con el reto empiece con `bits` ceros. */
async function resolverPrueba(reto: string, bits: number): Promise<string> {
  const enc = new TextEncoder()
  const cumple = (h: Uint8Array) => {
    for (let i = 0; i < bits; i++) if ((h[i >> 3] >> (7 - (i & 7))) & 1) return false
    return true
  }
  for (let base = 0; ; base += 256) {
    const lote = await Promise.all(
      Array.from({ length: 256 }, (_, i) => crypto.subtle.digest('SHA-256', enc.encode(`${reto}:${base + i}`))),
    )
    const i = lote.findIndex((h) => cumple(new Uint8Array(h)))
    if (i >= 0) return String(base + i)
  }
}

function cargarTurnstile(sitio: string) {
  const s = document.createElement('script')
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
  s.async = true
  s.onload = () => {
    const ts = (window as unknown as { turnstile?: { render: (el: HTMLElement, o: object) => void } }).turnstile
    ts?.render($('#ct-turnstile'), {
      sitekey: sitio,
      appearance: 'interaction-only',
      callback: (t: string) => (turnstileToken = t),
      'expired-callback': () => (turnstileToken = ''),
    })
  }
  document.head.appendChild(s)
}

function estadoContacto(titulo: string, detalle = '', url = '') {
  $('#ct-estado').hidden = false
  $('#ct-sin-servidor').hidden = true
  $('#ct-titulo').textContent = titulo
  $('#ct-detalle').textContent = detalle
  $('#ct-abrir').hidden = !url
  if (url) $('#ct-abrir').setAttribute('href', url)
  $('#ct-error').textContent = ''
}

async function abrirContacto() {
  const dlg = $('#dlg-contacto') as HTMLDialogElement
  if (!contactoDisponible) {
    $('#ct-estado').hidden = true
    $('#ct-sin-servidor').hidden = false
    $('#ct-app').hidden = !APP_EN_VIVO
    if (APP_EN_VIVO) $('#ct-app').setAttribute('href', APP_EN_VIVO)
    $('#ct-error').textContent = ''
    return dlg.showModal()
  }
  // La pestaña se abre YA (en el clic) para que el navegador no la bloquee; luego se le pone la dirección
  const ventana = enArtefacto() ? null : window.open('', '_blank')
  if (ventana) ventana.document.write('<title>Abriendo WhatsApp…</title><p style="font:16px system-ui;padding:24px">Abriendo WhatsApp…</p>')
  estadoContacto('Verificando que eres una persona…', 'Esto evita que los bots obtengan mi número. Tarda un segundo.')
  dlg.showModal()
  try {
    const reto = await api.contactoReto()
    const nonce = await resolverPrueba(reto.reto, reto.dificultad)
    const { url } = await api.contactoWhatsApp({
      ...reto,
      nonce,
      msEnPagina: Math.round(performance.now() - cargaPagina),
      interacciones,
      ...(turnstileToken ? { turnstile: turnstileToken } : {}),
    })
    if (ventana && !ventana.closed) {
      ventana.location.href = url
      dlg.close()
      toast('Abriendo WhatsApp…')
    } else {
      estadoContacto('✓ Listo', 'Toca el botón para abrir el chat.', url)
    }
  } catch (err) {
    ventana?.close()
    $('#ct-titulo').textContent = 'No se pudo abrir el chat'
    $('#ct-detalle').textContent = ''
    $('#ct-error').textContent = err instanceof Error ? err.message : 'Intenta de nuevo'
  }
}
$('[data-close-contacto]').addEventListener('click', () => ($('#dlg-contacto') as HTMLDialogElement).close())
$('#ct-abrir').addEventListener('click', () => setTimeout(() => ($('#dlg-contacto') as HTMLDialogElement).close(), 300))

// ------------------------------------------------------------------ inicio
cargarFormulario()
renderPaper()
pintarCuenta()
if (enArtefacto()) {
  void gmailDisponible().then((ok) => (gmailArtefacto = ok))
  void iaArtefactoDisponible().then((ok) => {
    iaArtefacto = ok
    if (ok && !emisor.apiKey) $('#motor').textContent = 'Claude'
  })
}
api.disponible().then(async ({ ok, ia, correo }) => {
  correoServidor = correo
  backendDisponible = ok
  iaServidor = ia
  if (ok && repo.modo === 'local' && !store.tieneEmisorPropio()) {
    try {
      const { apiKey: _k, ...pred } = await api.emisorPredeterminado()
      emisor = { ...emisor, ...pred }
      refrescar()
    } catch {
      /* sigue con los datos locales */
    }
  }
  if (ok) {
    const c = await api.contactoEstado()
    contactoDisponible = c.disponible
    turnstileSitio = c.turnstileSitio
    if (turnstileSitio) cargarTurnstile(turnstileSitio)
  }
  if (ia && !emisor.apiKey) $('#motor').textContent = 'Claude'
  if (!ok && repo.modo === 'nube') sesion.cerrar() // sin servidor: vuelve a local
  if (ok || repo.modo === 'nube') await cambiarRepo()
  pintarCuenta()
})
