import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

@Catch(Prisma.PrismaClientKnownRequestError)
export class DatabaseConflictFilter implements ExceptionFilter {
  catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error.code === 'P2034' || error.code === 'P2002') return response.status(409).json({ message: 'Los datos cambiaron o la operación ya existe. Actualiza antes de reintentar.' });
    if (error.code === 'P2025') return response.status(404).json({ message: 'El recurso ya no está disponible.' });
    return response.status(503).json({ message: 'No se pudo completar la operación. Reintenta después de actualizar.' });
  }
}
