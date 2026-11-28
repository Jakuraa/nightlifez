import crypto from "node:crypto";
import {
  hasPermission,
  type AppRole,
  type AuthSessionView,
  type Permission,
  type RoleAssignmentRecord,
  type RoleScope
} from "@nightlifez/shared";

export const SESSION_COOKIE_NAME = "nlz_session";

function getSigningSecret(): string {
  const secret = process.env.NIGHTLIFEZ_SESSION_SECRET;
  if (process.env.VERCEL_ENV === "production" && !secret) {
    throw new Error("NIGHTLIFEZ_SESSION_SECRET is required in Production.");
  }
  return secret || "nightlifez-local-development-only-signing-key";
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 2) return false;
  const [salt, hex] = parts;
  if (!salt || !hex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hex, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function signQrPayload(ticketId: string, eventId: string, ticketCode: string): string {
  const payload = `${ticketId}.${eventId}.${ticketCode}`;
  const sig = crypto.createHmac("sha256", getSigningSecret()).update(payload).digest("hex").slice(0, 24);
  return `NLZ1.${payload}.${sig}`;
}

export function verifyQrPayload(qrToken: string): {
  validFormat: boolean;
  ticketId?: string;
  eventId?: string;
  ticketCode?: string;
} {
  if (!qrToken.startsWith("NLZ1.")) return { validFormat: false };
  const parts = qrToken.split(".");
  if (parts.length !== 5) return { validFormat: false };
  const [, ticketId, eventId, ticketCode, sig] = parts;
  const expectedSig = crypto
    .createHmac("sha256", getSigningSecret())
    .update(`${ticketId}.${eventId}.${ticketCode}`)
    .digest("hex")
    .slice(0, 24);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { validFormat: false };
  }
  return { validFormat: true, ticketId, eventId, ticketCode };
}

// Simple sliding-window in-memory rate limiter for API routes
const rateWindows = new Map<string, number[]>();

export function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const timestamps = rateWindows.get(key) ?? [];
  const recent = timestamps.filter((t) => now - t < windowMs);
  if (recent.length >= maxRequests) {
    rateWindows.set(key, recent);
    return false;
  }
  recent.push(now);
  rateWindows.set(key, recent);
  return true;
}

export function extractSessionTokenFromRequest(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (name === SESSION_COOKIE_NAME && val) {
      return decodeURIComponent(val);
    }
  }
  return null;
}

export function extractRolesFromAssignments(assignments: readonly RoleAssignmentRecord[]): AppRole[] {
  const set = new Set<AppRole>();
  for (const a of assignments) set.add(a.role);
  if (set.size === 0) set.add("attendee");
  return Array.from(set);
}

export function assertAuthorized(
  session: AuthSessionView,
  permission: Permission,
  scope?: RoleScope
): { ok: true } | { ok: false; response: Response } {
  if (!session.user) {
    return {
      ok: false,
      response: Response.json({ error: "Authentication required." }, { status: 401 })
    };
  }
  if (session.user.status === "SUSPENDED") {
    return {
      ok: false,
      response: Response.json({ error: "Account is suspended." }, { status: 403 })
    };
  }
  if (!hasPermission(session.assignments, permission, scope)) {
    return {
      ok: false,
      response: Response.json(
        { error: `Forbidden: missing permission "${permission}" for requested scope.` },
        { status: 403 }
      )
    };
  }
  return { ok: true };
}
