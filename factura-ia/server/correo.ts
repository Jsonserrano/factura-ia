/** Envío de correos transaccionales con Brevo (plan gratis: 300 correos/día). */

export async function enviarCorreoBrevo(opts: {
  apiKey: string
  remitente: string
  para: string
  asunto: string
  html: string
  adjuntos?: { nombre: string; base64: string }[]
  responderA?: string
}) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': opts.apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Factura·IA', email: opts.remitente },
      to: [{ email: opts.para }],
      subject: opts.asunto,
      htmlContent: opts.html,
      ...(opts.adjuntos?.length ? { attachment: opts.adjuntos.map((a) => ({ name: a.nombre, content: a.base64 })) } : {}),
      ...(opts.responderA ? { replyTo: { email: opts.responderA } } : {}),
    }),
  })
  if (!res.ok) throw new Error(`Brevo ${res.status}`)
}
