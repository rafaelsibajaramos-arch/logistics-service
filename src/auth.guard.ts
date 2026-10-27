import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    if (request.path.endsWith('/health') || request.path.endsWith('/health/ready')) return true;

    const [scheme, token] = String(request.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedException('Falta el token Bearer');
    try {
      const publicKey = decodePublicKey(process.env.JWT_PUBLIC_KEY ?? '');
      const claims = await this.jwt.verifyAsync(token, {
        publicKey,
        algorithms: ['RS256'],
        issuer: process.env.JWT_ISSUER ?? 'farmtotable-identity',
        audience: process.env.JWT_AUDIENCE ?? 'farmtotable-api',
      });
      if (!claims.sub || !Array.isArray(claims.roles)) throw new Error('claims incompletos');
      request.user = { sub: String(claims.sub), roles: claims.roles.map(String) };
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}

function decodePublicKey(value: string): string {
  const normalized = value.replace(/\\n/g, '\n').trim();
  if (normalized.includes('BEGIN ')) return normalized;
  return Buffer.from(normalized, 'base64').toString('utf8').replace(/\\n/g, '\n').trim();
}
