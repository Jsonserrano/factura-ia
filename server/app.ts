import express, { type Request } from 'express'
import cors from 'cors'
import { z } from 'zod'
import type { DB } from './db'
import { firmarToken, hashPassword, requiereAuth, verificarPassword } from './auth'
import { calcularTotales } from '../src/calc'
import { cadenaCufe, sha384 } from '../src/cufe'
import { generarUBL } from '../src/ubl'
import { parsearConClaude } from '../src/ai'
import { generarPDF } from '../src/pdf'
import { contenidoQR } from '../src/cufe'
import { cop, totalLinea } from '../src/calc'
import QRCode from 'qrcode'
import { enviarCorreoBrevo } from './correo'
import { crearReto, firmaValida, pruebaValida, verificarTurnstile, type Reto } from './contacto'
import { EMISOR_DEMO } from '../src/storage'
import type { Emisor, Factura } from '../src/types'

// ------------------------------------------------------------ validación (zod)
const RegistroSchema = z.object({
  nombre: z.string().trim().min(2).max(80),
  email: z.email().max(120),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(128),
})
const LoginSchema = z.object({ email: z.email(), password: z.string().min(1) })

const ItemSchema = z.object({
  id: z.string().optional(),
  descripcion: z.string().trim().min(1).max(200),
  cantidad: z.number().positive().max(1e6),
  precio: z.number().positive().max(1e11),
  descuentoPct: z.number().min(0).max(100).default(0),
  ivaPct: z.union([z.literal(0), z.literal(5), z.literal(19)]),
})

const NuevaFacturaSchema = z.object({
  cliente: z.object({
    nombre: z.string().trim().min(1).max(150),
    tipoDoc: z.enum(['CC', 'NIT', 'CE', 'PP']),
    documento: z.string().regex(/\d{5,}/, 'Documento inválido').max(20),
    email: z.string().max(120).default(''),
    telefono: z.string().max(30).default(''),
    direccion: z.string().max(200).default(''),
  }),
  items: z.array(ItemSchema).min(1).max(200),
  formaPago: z.enum(['Contado', 'Crédito']),
  medioPago: z.enum(['Efectivo', 'Transferencia', 'Nequi', 'Daviplata', 'Tarjeta']),
  retefuentePct: z.number().min(0).max(20).default(0),
  notas: z.string().max(1000).default(''),
  vence: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

const EmisorSchema = z.object({
  razonSocial: z.string().trim().min(1).max(150),
  nit: z.string().regex(/^\d{5,15}$/),
  direccion: z.string().max(200),
  ciudad: z.string().max(100),
  telefono: z.string().max(30),
  email: z.string().max(120),
  whatsapp: z.string().regex(/^\d{0,15}$/),
  resolucion: z.string().max(200),
  prefijo: z.string().regex(/^[A-Z0-9]{0,4}$/i),
  claveTecnica: z.string().max(100),
})

class HttpError extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(msg)
    this.status = status
  }
}

// ------------------------------------------------------------ app
export interface OpcionesApp {
  jwtSecret: string
  origenesCors?: string[]
  /** Llave de Claude del servidor: activa /api/ia para todos sin exponer la llave */
  anthropicKey?: string
  /** Peticiones de IA por IP por hora */
  limiteIA?: number
  /** Envío de facturas por correo (Brevo). En pruebas se inyecta `enviarFactura`. */
  correo?: {
    brevoKey?: string
    remitente?: string
    enviarFactura?: (c: CorreoFactura) => Promise<void>
    limiteDiario?: number
  }
  /** Datos del negocio por defecto que no deben quedar en el código público (ej. correo) */
  emisorPredeterminado?: Partial<Emisor>
  /** Botón directo a WhatsApp solo para humanos (el número vive solo en el servidor) */
  contacto?: {
    whatsapp?: string // dígitos con indicativo, ej. 57300…
    nombre?: string // a quién saluda el mensaje prellenado
    dificultad?: number // bits de la prueba de trabajo (16 ≈ 1 s en un celular)
    msMinimo?: number // tiempo mínimo en la página antes del clic
    porIpDia?: number
    globalDia?: number
    turnstileSecreto?: string // opcional: Cloudflare Turnstile
    turnstileSitio?: string
  }
}

export interface CorreoFactura {
  para: string
  asunto: string
  html: string
  adjuntos: { nombre: string; base64: string }[]
  responderA?: string
}

const escHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function crearApp(db: DB, opciones: OpcionesApp) {
  const app = express()
  app.disable('x-powered-by')
  app.use(cors({ origin: opciones.origenesCors ?? true }))
  app.use(express.json({ limit: '200kb' }))

  app.set('trust proxy', 1) // detrás del proxy de Render: IP real del cliente
  const auth = requiereAuth(opciones.jwtSecret)
  const uid = (req: Request) => req.usuario!.id

  // Helpers sobre libSQL
  type Arg = string | number | null
  const uno = async <T>(sql: string, args: Arg[] = []) => (await db.execute({ sql, args })).rows[0] as T | undefined
  const todos = async <T>(sql: string, args: Arg[] = []) => (await db.execute({ sql, args })).rows as unknown as T[]
  const ejecutar = (sql: string, args: Arg[] = []) => db.execute({ sql, args })

  const leerEmisor = async (usuarioId: number): Promise<Emisor> => {
    const fila = await uno<{ datos: string }>('SELECT datos FROM emisores WHERE usuario_id = ?', [usuarioId])
    return { ...EMISOR_DEMO, ...opciones.emisorPredeterminado, apiKey: '', ...(fila ? JSON.parse(fila.datos) : {}) }
  }
  const leerFactura = async (usuarioId: number, numero: string): Promise<Factura> => {
    const fila = await uno<{ datos: string; estado: Factura['estado'] }>(
      'SELECT datos, estado FROM facturas WHERE usuario_id = ? AND numero = ?',
      [usuarioId, numero],
    )
    if (!fila) throw new HttpError(404, 'Factura no encontrada')
    return { ...(JSON.parse(fila.datos) as Factura), estado: fila.estado }
  }

  app.get('/api/salud', (_req, res) => {
    res.json({
      ok: true,
      servicio: 'factura-ia',
      ia: Boolean(opciones.anthropicKey),
      correo: Boolean(opciones.correo?.enviarFactura || (opciones.correo?.brevoKey && opciones.correo?.remitente)),
      hora: new Date().toISOString(),
    })
  })

  /** Datos públicos del negocio para quien usa la app sin cuenta (sin secretos) */
  app.get('/api/emisor/predeterminado', (_req, res) => {
    res.json({ ...EMISOR_DEMO, ...opciones.emisorPredeterminado, apiKey: '', claveTecnica: EMISOR_DEMO.claveTecnica })
  })

  // ---------------- usuarios
  app.post('/api/auth/registro', async (req, res) => {
    const datos = RegistroSchema.parse(req.body)
    const existe = await uno('SELECT 1 FROM usuarios WHERE email = ?', [datos.email])
    if (existe) throw new HttpError(409, 'Ese correo ya está registrado')
    const hash = await hashPassword(datos.password)
    const r = await ejecutar('INSERT INTO usuarios (email, nombre, password_hash) VALUES (?, ?, ?)', [
      datos.email,
      datos.nombre,
      hash,
    ])
    const usuario = { id: Number(r.lastInsertRowid), email: datos.email, nombre: datos.nombre }
    res.status(201).json({ token: firmarToken(usuario, opciones.jwtSecret), usuario })
  })

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = LoginSchema.parse(req.body)
    const u = await uno<{ id: number; email: string; nombre: string; password_hash: string }>(
      'SELECT id, email, nombre, password_hash FROM usuarios WHERE email = ?',
      [email],
    )
    // mismo mensaje para correo inexistente o clave errada (no revela qué cuentas existen)
    if (!u || !(await verificarPassword(password, u.password_hash))) throw new HttpError(401, 'Correo o contraseña incorrectos')
    const usuario = { id: u.id, email: u.email, nombre: u.nombre }
    res.json({ token: firmarToken(usuario, opciones.jwtSecret), usuario })
  })

  app.get('/api/me', auth, async (req, res) => {
    const u = await uno<{ id: number; email: string; nombre: string; creado_en: string }>(
      'SELECT id, email, nombre, creado_en FROM usuarios WHERE id = ?',
      [uid(req)],
    )
    if (!u) throw new HttpError(404, 'Usuario no existe')
    res.json({ id: Number(u.id), email: u.email, nombre: u.nombre, creado_en: u.creado_en })
  })

  // ---------------- datos del negocio
  app.get('/api/emisor', auth, async (req, res) => {
    res.json(await leerEmisor(uid(req)))
  })
  app.put('/api/emisor', auth, async (req, res) => {
    const datos = EmisorSchema.parse(req.body)
    await ejecutar(
      'INSERT INTO emisores (usuario_id, datos) VALUES (?, ?) ON CONFLICT(usuario_id) DO UPDATE SET datos = excluded.datos',
      [uid(req), JSON.stringify(datos)],
    )
    res.json(await leerEmisor(uid(req)))
  })

  // ---------------- facturas
  app.get('/api/facturas', auth, async (req, res) => {
    const filas = await todos<{ datos: string; estado: Factura['estado'] }>(
      'SELECT datos, estado FROM facturas WHERE usuario_id = ? ORDER BY consecutivo DESC LIMIT 500',
      [uid(req)],
    )
    res.json(filas.map((f) => ({ ...JSON.parse(f.datos), estado: f.estado })))
  })

  app.get('/api/facturas/resumen', auth, async (req, res) => {
    const r = await uno<{ facturas: number; facturado: number; porCobrar: number }>(
        `SELECT COUNT(*) AS facturas,
                COALESCE(SUM(CASE WHEN estado != 'Anulada' THEN neto_pagar END), 0) AS facturado,
                COALESCE(SUM(CASE WHEN estado = 'Pendiente' THEN neto_pagar END), 0) AS porCobrar
           FROM facturas WHERE usuario_id = ?`,
      [uid(req)],
    )
    res.json({ facturas: Number(r?.facturas ?? 0), facturado: Number(r?.facturado ?? 0), porCobrar: Number(r?.porCobrar ?? 0) })
  })

  /** Emite: el servidor asigna consecutivo, fecha, calcula totales y CUFE (el cliente no decide montos). */
  app.post('/api/facturas', auth, async (req, res) => {
    const entrada = NuevaFacturaSchema.parse(req.body)
    const emisor = await leerEmisor(uid(req))
    const fecha = new Date().toISOString()

    // El consecutivo se asigna dentro de una transacción de escritura para que nunca se repita
    const tx = await db.transaction('write')
    try {
      const fila = (
        await tx.execute({
          sql: 'SELECT COALESCE(MAX(consecutivo), 0) + 1 AS siguiente FROM facturas WHERE usuario_id = ?',
          args: [uid(req)],
        })
      ).rows[0]
      const siguiente = Number(fila.siguiente)
      const factura: Factura = {
        ...entrada,
        items: entrada.items.map((it, i) => ({ ...it, id: it.id ?? String(i + 1) })),
        numero: `${emisor.prefijo}${String(siguiente).padStart(4, '0')}`,
        consecutivo: siguiente,
        fecha,
        estado: 'Pendiente',
      }
      const totales = calcularTotales(factura)
      factura.cufe = await sha384(cadenaCufe(factura, totales, emisor))
      await tx.execute({
        sql: 'INSERT INTO facturas (usuario_id, consecutivo, numero, cufe, neto_pagar, datos) VALUES (?, ?, ?, ?, ?, ?)',
        args: [uid(req), siguiente, factura.numero, factura.cufe, totales.netoPagar, JSON.stringify(factura)],
      })
      await tx.commit()
      res.status(201).json({ factura, totales })
    } finally {
      tx.close() // si no hubo commit, hace rollback
    }
  })

  app.get('/api/facturas/:numero', auth, async (req, res) => {
    const f = await leerFactura(uid(req), String(req.params.numero))
    res.json({ factura: f, totales: calcularTotales(f) })
  })

  app.patch('/api/facturas/:numero/estado', auth, async (req, res) => {
    const { estado } = z.object({ estado: z.enum(['Pagada', 'Anulada']) }).parse(req.body)
    const actual = await leerFactura(uid(req), String(req.params.numero))
    if (actual.estado !== 'Pendiente') throw new HttpError(409, `La factura ya está ${actual.estado.toLowerCase()}`)
    await ejecutar('UPDATE facturas SET estado = ? WHERE usuario_id = ? AND numero = ?', [estado, uid(req), actual.numero])
    res.json({ ...actual, estado })
  })

  app.get('/api/facturas/:numero/xml', auth, async (req, res) => {
    const f = await leerFactura(uid(req), String(req.params.numero))
    const xml = generarUBL(f, calcularTotales(f), await leerEmisor(uid(req)), f.cufe!)
    res.type('application/xml').attachment(`${f.numero}.xml`).send(xml)
  })

  // ---------------- PDF y envío por correo
  const pdfDe = async (f: Factura, e: Emisor) => {
    const t = calcularTotales(f)
    const qr = await QRCode.toBuffer(contenidoQR(f, t, e, f.cufe!), { margin: 4, width: 640, errorCorrectionLevel: 'L' })
    return { pdf: await generarPDF(f, t, e, f.cufe!, new Uint8Array(qr)), t }
  }

  app.get('/api/facturas/:numero/pdf', auth, async (req, res) => {
    const f = await leerFactura(uid(req), String(req.params.numero))
    const { pdf } = await pdfDe(f, await leerEmisor(uid(req)))
    res.type('application/pdf').attachment(`${f.numero}.pdf`).send(Buffer.from(pdf))
  })

  const correoCfg = opciones.correo ?? {}
  const enviarFactura =
    correoCfg.enviarFactura ??
    (correoCfg.brevoKey && correoCfg.remitente
      ? (c: CorreoFactura) =>
          enviarCorreoBrevo({
            apiKey: correoCfg.brevoKey!,
            remitente: correoCfg.remitente!,
            para: c.para,
            asunto: c.asunto,
            html: c.html,
            adjuntos: c.adjuntos,
            responderA: c.responderA,
          })
      : undefined)
  const enviosHoy = new Map<number, { n: number; dia: string }>()

  app.post('/api/facturas/:numero/enviar', auth, async (req, res) => {
    if (!enviarFactura) throw new HttpError(503, 'El envío por correo no está configurado en el servidor')
    const { email } = z.object({ email: z.email().optional() }).parse(req.body ?? {})
    const f = await leerFactura(uid(req), String(req.params.numero))
    const para = email ?? f.cliente.email
    if (!para) throw new HttpError(400, 'La factura no tiene correo del cliente')
    if (f.estado === 'Anulada') throw new HttpError(409, 'No se envían facturas anuladas')

    const dia = new Date().toISOString().slice(0, 10)
    const uso = enviosHoy.get(uid(req))
    if (!uso || uso.dia !== dia) enviosHoy.set(uid(req), { n: 1, dia })
    else if (++uso.n > (correoCfg.limiteDiario ?? 30)) throw new HttpError(429, 'Límite diario de correos alcanzado')

    const e = await leerEmisor(uid(req))
    const { pdf, t } = await pdfDe(f, e)
    const xml = generarUBL(f, t, e, f.cufe!)
    const filas = f.items
      .map((i) => `<tr><td>${i.cantidad} × ${escHtml(i.descripcion)}</td><td align="right">${cop.format(totalLinea(i).total)}</td></tr>`)
      .join('')
    await enviarFactura({
      para,
      asunto: `Factura electrónica ${f.numero} de ${e.razonSocial}`,
      responderA: e.email || undefined,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#14140f">
        <h2 style="margin:0 0 4px">${escHtml(e.razonSocial)}</h2>
        <p style="color:#6d6b60;margin:0 0 16px">NIT ${escHtml(e.nit)}</p>
        <p>Hola ${escHtml(f.cliente.nombre)},</p>
        <p>Adjuntamos tu factura electrónica de venta <b>${escHtml(f.numero)}</b> en PDF y su XML (UBL 2.1).</p>
        <table width="100%" cellpadding="6" style="border-collapse:collapse;border-top:1px solid #e2dfd3;border-bottom:1px solid #e2dfd3">${filas}</table>
        <p style="font-size:18px"><b>Total a pagar: ${cop.format(t.netoPagar)}</b></p>
        <p style="color:#6d6b60;font-size:12px">CUFE: ${f.cufe}<br>Documento generado en ambiente de pruebas, sin validez fiscal.</p>
      </div>`,
      adjuntos: [
        { nombre: `${f.numero}.pdf`, base64: Buffer.from(pdf).toString('base64') },
        { nombre: `${f.numero}.xml`, base64: Buffer.from(xml, 'utf-8').toString('base64') },
      ],
    })
    res.json({ enviado: true, para })
  })

  // ---------------- IA (la llave de Claude vive solo en el servidor)
  const usosIA = new Map<string, { n: number; reinicio: number }>()
  app.post('/api/ia', async (req, res) => {
    if (!opciones.anthropicKey) throw new HttpError(503, 'IA del servidor no configurada')
    const { texto } = z.object({ texto: z.string().trim().min(2).max(1000) }).parse(req.body)
    const ip = req.ip ?? 'desconocida'
    const ahora = Date.now()
    const uso = usosIA.get(ip)
    if (!uso || uso.reinicio < ahora) usosIA.set(ip, { n: 1, reinicio: ahora + 3600_000 })
    else if (++uso.n > (opciones.limiteIA ?? 30)) throw new HttpError(429, 'Límite de IA alcanzado, intenta en una hora')
    try {
      res.json({ items: await parsearConClaude(texto, opciones.anthropicKey), motor: 'Claude' })
    } catch (err) {
      console.error('Claude', err)
      throw new HttpError(502, 'La IA no respondió')
    }
  })

  // ---------------- WhatsApp directo (solo humanos)
  const cfg = opciones.contacto ?? {}
  const DIF = cfg.dificultad ?? 16
  const usados = new Map<string, number>() // retos ya canjeados → expiración
  const porIp = new Map<string, { n: number; dia: string }>()
  let global = { n: 0, dia: '' }

  app.get('/api/contacto/estado', (_req, res) => {
    res.json({ disponible: Boolean(cfg.whatsapp), turnstileSitio: cfg.turnstileSitio ?? null })
  })

  app.get('/api/contacto/reto', (_req, res) => {
    if (!cfg.whatsapp) throw new HttpError(503, 'El contacto no está configurado')
    res.set('Cache-Control', 'no-store').json(crearReto(opciones.jwtSecret, DIF))
  })

  app.post('/api/contacto/whatsapp', async (req, res) => {
    if (!cfg.whatsapp) throw new HttpError(503, 'El contacto no está configurado')
    const d = z
      .object({
        reto: z.string().regex(/^[a-f0-9]{32}$/),
        emitido: z.number().int(),
        dificultad: z.number().int(),
        firma: z.string().max(128),
        nonce: z.string().regex(/^\d{1,12}$/),
        msEnPagina: z.number().min(0),
        interacciones: z.number().int().min(0),
        turnstile: z.string().max(4096).optional(),
      })
      .parse(req.body)
    const ahora = Date.now()
    const reto: Reto = { reto: d.reto, emitido: d.emitido, dificultad: d.dificultad, firma: d.firma }

    if (d.dificultad !== DIF || !firmaValida(opciones.jwtSecret, reto)) throw new HttpError(403, 'Verificación inválida')
    if (ahora - d.emitido > 120_000) throw new HttpError(403, 'La verificación venció, intenta de nuevo')
    for (const [k, exp] of usados) if (exp < ahora) usados.delete(k)
    if (usados.has(d.reto)) throw new HttpError(403, 'Verificación ya usada')
    usados.set(d.reto, d.emitido + 120_000)
    if (!pruebaValida(d.reto, d.nonce, d.dificultad)) throw new HttpError(403, 'Verificación inválida')
    if (d.msEnPagina < (cfg.msMinimo ?? 2500) || d.interacciones < 1)
      throw new HttpError(403, 'No pudimos confirmar que eres una persona. Mueve el cursor o toca la pantalla e intenta de nuevo.')
    if (cfg.turnstileSecreto) {
      if (!d.turnstile || !(await verificarTurnstile(cfg.turnstileSecreto, d.turnstile, req.ip)))
        throw new HttpError(403, 'No pudimos confirmar que eres una persona')
    }

    const dia = new Date().toISOString().slice(0, 10)
    const ip = req.ip ?? 'desconocida'
    const uso = porIp.get(ip)
    if (!uso || uso.dia !== dia) porIp.set(ip, { n: 1, dia })
    else if (++uso.n > (cfg.porIpDia ?? 5)) throw new HttpError(429, 'Ya abriste el chat varias veces hoy')
    if (global.dia !== dia) global = { n: 0, dia }
    if (++global.n > (cfg.globalDia ?? 100)) throw new HttpError(429, 'Límite diario alcanzado, intenta mañana')

    const texto = `Hola${cfg.nombre ? ' ' + cfg.nombre : ''}, vi tu proyecto Factura·IA y me gustaría hablar contigo.`
    res.set('Cache-Control', 'no-store').json({ url: `https://wa.me/${cfg.whatsapp}?text=${encodeURIComponent(texto)}` })
  })

  // ---------------- errores
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' })
  })
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Datos inválidos', detalles: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'JSON mal formado' })
    console.error(err)
    res.status(500).json({ error: 'Error interno' })
  })

  return app
}
