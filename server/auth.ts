import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const API_ROLES = ['admin', 'operator', 'auditor', 'runtime'] as const;
export type ApiRole = (typeof API_ROLES)[number];

export interface ApiCredential {
  id: string;
  token: string;
  roles: ApiRole[];
}

export interface ApiIdentity {
  id: string;
  roles: ApiRole[];
}

export class AuthConfigurationError extends Error {}
export class AuthRequestError extends Error {
  constructor(message: string, readonly statusCode: 401 | 403) {
    super(message);
  }
}

declare global {
  namespace Express {
    interface Request {
      asguardIdentity?: ApiIdentity;
    }
  }
}

function validateCredentials(value: unknown): ApiCredential[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AuthConfigurationError('ASGUARD_API_CREDENTIALS must be a non-empty JSON array.');
  }

  const identities = new Set<string>();
  const tokens = new Set<string>();

  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new AuthConfigurationError('Each API credential must be an object.');
    }

    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const token = typeof record.token === 'string' ? record.token.trim() : '';
    const roles = record.roles;

    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      throw new AuthConfigurationError('Each API credential must have a valid id.');
    }
    if (Buffer.byteLength(token, 'utf8') < 32) {
      throw new AuthConfigurationError(`API credential ${id} must have a token of at least 32 bytes.`);
    }
    if (!Array.isArray(roles) || roles.length === 0 || !roles.every(
      (role): role is ApiRole => typeof role === 'string' && API_ROLES.includes(role as ApiRole)
    )) {
      throw new AuthConfigurationError(`API credential ${id} must have one or more valid roles.`);
    }
    if (identities.has(id) || tokens.has(token)) {
      throw new AuthConfigurationError('API credential ids and tokens must be unique.');
    }

    identities.add(id);
    tokens.add(token);
    return { id, token, roles: [...new Set(roles)] };
  });
}

export function parseApiCredentials(value = process.env.ASGUARD_API_CREDENTIALS): ApiCredential[] {
  if (!value?.trim()) {
    throw new AuthConfigurationError('ASGUARD_API_CREDENTIALS must be configured before starting the backend.');
  }

  try {
    return validateCredentials(JSON.parse(value));
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      throw error;
    }
    throw new AuthConfigurationError('ASGUARD_API_CREDENTIALS must contain valid JSON.');
  }
}

export class ApiAuthenticator {
  private readonly credentials: ApiCredential[];

  constructor(credentials: ApiCredential[]) {
    this.credentials = validateCredentials(credentials);
  }

  authenticate(req: Pick<Request, 'headers'>): ApiIdentity {
    const authorization = req.headers.authorization;
    const headerToken = req.headers['x-asguard-key'];
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : typeof headerToken === 'string'
        ? headerToken.trim()
        : '';

    if (!token) {
      throw new AuthRequestError('Missing or invalid Authorization header.', 401);
    }

    const received = Buffer.from(token, 'utf8');
    let matchedCredential: ApiCredential | undefined;
    for (const credential of this.credentials) {
      const expected = Buffer.from(credential.token, 'utf8');
      if (received.length === expected.length && timingSafeEqual(received, expected)) {
        matchedCredential = credential;
      }
    }

    if (!matchedCredential) {
      throw new AuthRequestError('Invalid or expired token.', 401);
    }

    return { id: matchedCredential.id, roles: [...matchedCredential.roles] };
  }

  authenticationMiddleware(): RequestHandler {
    return (req, res, next) => {
      try {
        req.asguardIdentity = this.authenticate(req);
        next();
      } catch (error) {
        this.sendAuthError(res, error);
      }
    };
  }

  requireAnyRole(...roles: ApiRole[]): RequestHandler {
    return (req, res, next) => {
      const identity = req.asguardIdentity;
      if (!identity) {
        res.status(401).json({ success: false, error: 'Authentication required.' });
        return;
      }

      if (!roles.some((role) => identity.roles.includes(role))) {
        res.status(403).json({ success: false, error: 'Insufficient role.' });
        return;
      }

      next();
    };
  }

  private sendAuthError(res: Response, error: unknown): void {
    const configurationError = error instanceof AuthConfigurationError;
    const status = error instanceof AuthRequestError ? error.statusCode : configurationError ? 503 : 401;
    const message = error instanceof Error ? error.message : 'Authentication failed.';
    res.status(status).json({ success: false, error: message });
  }
}
