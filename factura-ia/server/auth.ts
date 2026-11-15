import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import jwt from 'jsonwebtoken'
import type { NextFunction, Request, Response } from 'express'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>

/** Hash de contraseña con scrypt + sal aleatoria. Formato: scrypt$<sal>$<hash> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verificarPassword(password: string, guardado: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = guardado.split('$')
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false
  const esperado = Buffer.from(hashB64, 'base64')
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), esperado.length)
  return timingSafeEqual(esperado, actual)
}

export interface UsuarioToken {
  id: number
  email: string
}

export function firmarToken(u: UsuarioToken, secreto: string): string {
  return jwt.sign({ email: u.email }, secreto, { subject: String(u.id), expiresIn: '7d' })
}

declare module 'express-serve-static-core' {
  interface Request {
    usuario?: UsuarioToken
  }
}

/** Middleware: exige "Authorization: Bearer <token>" válido. */
export function requiereAuth(secreto: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const [tipo, token] = (req.headers.authorization ?? '').split(' ')
    if (tipo !== 'Bearer' || !token) return res.status(401).json({ error: 'Falta el token de sesión' })
    try {
      const p = jwt.verify(token, secreto) as jwt.JwtPayload
      req.usuario = { id: Number(p.sub), email: String(p.email) }
      next()
    } catch {
      res.status(401).json({ error: 'Sesión inválida o vencida' })
    }
  }
}
