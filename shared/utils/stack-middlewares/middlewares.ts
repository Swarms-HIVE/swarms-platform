import { NextFetchEvent, NextRequest, NextResponse } from 'next/server';
import { MiddlewareFactory } from './types';
import { updateSession } from '@/shared/utils/supabase/middleware';
import { Ratelimit } from '@upstash/ratelimit';
import { kv } from '@vercel/kv';
import { generateFingerprint } from '../auth-helpers/fingerprinting';

/**
 * Rate limiting configuration for API routes
 */
const ratelimit = new Ratelimit({
  redis: kv,
  limiter: Ratelimit.slidingWindow(300, '60 s'),
});

/**
 * Gets the real IP address from various possible headers
 */
const getIpAddress = (request: NextRequest): string => {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');

  if (forwarded) {
    // Get the first IP if there are multiple (proxy chains)
    const forwardedIp = forwarded.split(',')[0].trim();
    // Convert localhost IPv6 to IPv4 for consistency
    if (forwardedIp === '::1') {
      return '127.0.0.1';
    }
    return forwardedIp;
  }

  if (realIp) {
    // Convert localhost IPv6 to IPv4 for consistency
    if (realIp === '::1') {
      return '127.0.0.1';
    }
    return realIp;
  }

  const fallbackIp = '127.0.0.1';
  return fallbackIp;
};

/**
 * Middleware factory for API rate limiting
 */
const withRateLimit: MiddlewareFactory = (next) => {
  return async (request: NextRequest, event: NextFetchEvent) => {
    // skip limit for Stripe webhook
    if (request.nextUrl.pathname.includes('/api/webhooks')) {
      return next(request, event);
    }

    // skip limit for explorer data (high-frequency public queries)
    if (request.nextUrl.pathname.includes('/api/trpc/explorer.getExplorerData')) {
      return next(request, event);
    }

    if (request.nextUrl.pathname.includes('/api')) {
      const ip = getIpAddress(request);
      const { success } = await ratelimit.limit(ip);

      if (!success) {
        return NextResponse.json(
          { error: 'Too many requests' },
          { status: 429 },
        );
      }
    }

    return next(request, event);
  };
};

const SECURITY_CONFIG = {
  MAX_PAYLOAD_SIZE: 500000,
  MAX_FIELD_LENGTH: 1000,
  MAX_FORM_FIELDS: 10,
  REQUEST_TIMEOUT: 5000,
  MAX_NESTING_DEPTH: 3,
} as const;

function checkNestingDepth(obj: any, depth = 0, visited = new Set()): boolean {
  if (depth > SECURITY_CONFIG.MAX_NESTING_DEPTH) return true;
  if (typeof obj !== 'object' || obj === null) return false;
  if (visited.has(obj)) return true;

  visited.add(obj);
  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      if (checkNestingDepth(obj[key], depth + 1, visited)) {
        return true;
      }
    }
  }
  visited.delete(obj);
  return false;
}

const withSecurityChecks: MiddlewareFactory = (next) => {
  return async (request: NextRequest, event: NextFetchEvent) => {
    if (request.nextUrl.pathname === '/signin/password_signin') {
      if (request.method === 'POST') {
        const contentType = request.headers.get('content-type') || '';
        if (
          !contentType.includes('application/json') &&
          !contentType.includes('application/x-www-form-urlencoded') &&
          !contentType.includes('multipart/form-data')
        ) {
          return new NextResponse(
            JSON.stringify({ error: 'Unsupported content type' }),
            {
              status: 415,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          );
        }

        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error('Request timeout')),
            SECURITY_CONFIG.REQUEST_TIMEOUT,
          );
        });

        try {
          await Promise.race([
            (async () => {
              const contentLength = parseInt(
                request.headers.get('content-length') || '0',
                10,
              );
              if (contentLength > SECURITY_CONFIG.MAX_PAYLOAD_SIZE) {
                throw new Error('Payload too large');
              }

              if (contentType.includes('application/json')) {
                const clonedRequest = request.clone();
                const rawText = await clonedRequest.text();

                if (rawText.length > SECURITY_CONFIG.MAX_PAYLOAD_SIZE) {
                  throw new Error('Payload too large');
                }

                let body;
                try {
                  body = JSON.parse(rawText);
                } catch {
                  throw new Error('Invalid JSON payload');
                }

                if (checkNestingDepth(body)) {
                  throw new Error('Payload structure too complex');
                }

                if (
                  !body.email ||
                  !body.password ||
                  typeof body.email !== 'string' ||
                  typeof body.password !== 'string'
                ) {
                  throw new Error('Invalid credentials format');
                }

                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(body.email)) {
                  throw new Error('Invalid email format');
                }

                if (body.password.length < 8 || body.password.length > 100) {
                  throw new Error('Invalid password length');
                }
              } else if (
                contentType.includes('application/x-www-form-urlencoded') ||
                contentType.includes('multipart/form-data')
              ) {
                try {
                  const formData = await request.formData();

                  const fieldCount = Array.from(formData.entries()).length;
                  if (fieldCount > SECURITY_CONFIG.MAX_FORM_FIELDS) {
                    throw new Error('Too many form fields');
                  }

                  for (const [key, value] of Array.from(formData.entries())) {
                    if (
                      typeof value === 'string' &&
                      value.length > SECURITY_CONFIG.MAX_FIELD_LENGTH
                    ) {
                      throw new Error('Form field too large');
                    }

                    if (
                      typeof value === 'string' &&
                      (value.includes('script') ||
                        value.includes('<') ||
                        value.includes('>') ||
                        value.includes('${') ||
                        value.includes('eval('))
                    ) {
                      throw new Error('Invalid form data content');
                    }
                  }
                } catch (error) {
                  throw new Error('Invalid form data');
                }
              }
            })(),
            timeoutPromise,
          ]);
        } catch (error) {
          const errorMessage =
            (error as Error).message || 'Request processing failed';
          return new NextResponse(JSON.stringify({ error: errorMessage }), {
            status: errorMessage === 'Payload too large' ? 413 : 400,
            headers: {
              'Content-Type': 'application/json',
            },
          });
        }
      }
    }

    return next(request, event);
  };
};

const withUpdateSession: MiddlewareFactory = (next) => {
  return async (req: NextRequest, _next: NextFetchEvent) => {
    await updateSession(req);
    return next(req, _next);
  };
};

export const withFingerPrinting: MiddlewareFactory = (next) => {
  return async (req: NextRequest, _next: NextFetchEvent) => {
    const res = await next(req, _next);

    const isSignupOrCallback =
      req.nextUrl.pathname.startsWith('/signin/signup') ||
      req.nextUrl.pathname.startsWith('/auth/callback');

    if (isSignupOrCallback) {
      const ip =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
      const userAgent = req.headers.get('user-agent') || 'unknown';
      const acceptLanguage = req.headers.get('accept-language') || undefined;

      const fingerprint = generateFingerprint({
        ip,
        userAgent,
        language: acceptLanguage,
      });

      if (res instanceof NextResponse) {
        res.cookies.set('sf_rsint', fingerprint, {
          httpOnly: false,
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 30,
          path: '/',
        });
      }

      return res;
    }
  };
};

export const middlewares = [
  withRateLimit,
  withSecurityChecks,
  withUpdateSession,
  withFingerPrinting,
];
