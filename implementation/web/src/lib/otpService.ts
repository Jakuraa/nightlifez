import crypto from "node:crypto";
import {
  isOrganiserRole,
  isPlatformRole,
  isStaffRole,
  isVenueRole,
  maskPhoneNumber,
  normalizePhoneNumber,
  otpRequestSchema,
  otpResendSchema,
  otpVerifySchema,
  SYNTHETIC_QA_PHONES,
  type AuthSessionView,
  type OtpPurpose,
  type OtpRequestResult,
  type OtpVerifyResult,
  type RoleAssignmentRecord,
  type UserAccount,
  type WorkspaceOption
} from "@nightlifez/shared";
import {
  checkRateLimit,
  extractRolesFromAssignments,
  hashSessionToken
} from "./auth.ts";
import { ensureSchemaBootstrapped } from "./bootstrapDb.ts";
import { getPool } from "./db.ts";
import { getMemoryStore, type MemoryOtpChallengeRecord } from "./memoryStore.ts";
import { listOrganizations } from "./operationsStore.ts";
import { getSmsOtpProvider, isNonProductionEnvironment } from "./smsProvider.ts";

export const OTP_TTL_SECONDS = 300; // 5 minutes
export const OTP_RESEND_COOLDOWN_SECONDS = 30;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_RESENDS = 3;

/**
 * First platform-admin bootstrap is allowed only in Production and only for
 * the explicitly configured phone after that phone has completed OTP.
 * Synthetic QA numbers are never eligible.
 */
export function matchesInitialAdminPhone(
  verifiedPhone: string,
  runtimeEnvironment = process.env.VERCEL_ENV,
  configuredPhone = process.env.NIGHTLIFEZ_INITIAL_ADMIN_PHONE
): boolean {
  if (runtimeEnvironment !== "production" || !configuredPhone?.trim()) return false;
  try {
    const normalized = normalizePhoneNumber(configuredPhone);
    return normalized === verifiedPhone && !SYNTHETIC_QA_PHONES.has(normalized);
  } catch {
    return false;
  }
}

function getOtpHmacSecret(): string {
  const secret = process.env.NIGHTLIFEZ_SESSION_SECRET;
  if (process.env.VERCEL_ENV === "production" && !secret) {
    throw new Error("NIGHTLIFEZ_SESSION_SECRET is required in Production.");
  }
  return secret || "nightlifez-local-development-only-signing-key";
}

export function generateSixDigitOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export function hashOtpCode(challengeId: string, code: string): string {
  return crypto
    .createHmac("sha256", getOtpHmacSecret())
    .update(`${challengeId}:${code}`)
    .digest("hex");
}

export function verifyOtpHash(challengeId: string, code: string, expectedHash: string): boolean {
  const actualHex = hashOtpCode(challengeId, code);
  const a = Buffer.from(actualHex, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function resolveWorkspaces(
  assignments: readonly RoleAssignmentRecord[],
  orgNamesById: Map<string, string>
): { workspaces: WorkspaceOption[]; defaultWorkspacePath: string } {
  const seen = new Set<string>();
  const workspaces: WorkspaceOption[] = [];

  for (const a of assignments) {
    if (isPlatformRole(a.role)) {
      const key = `admin:${a.role}`;
      if (!seen.has(key)) {
        seen.add(key);
        workspaces.push({
          key,
          role: a.role,
          label: `Platform Console (${a.role.replace(/_/g, " ")})`,
          path: "/admin",
          organizationId: null,
          venueSlug: null,
          eventId: null
        });
      }
    } else if (isOrganiserRole(a.role)) {
      const orgId = a.organizationId ?? "default";
      const key = `organiser:${orgId}:${a.role}`;
      if (!seen.has(key)) {
        seen.add(key);
        const orgName = a.organizationId ? orgNamesById.get(a.organizationId) ?? a.organizationId : "Organiser";
        workspaces.push({
          key,
          role: a.role,
          label: `${orgName} (${a.role.replace(/_/g, " ")})`,
          path: "/organiser",
          organizationId: a.organizationId,
          organizationName: orgName,
          venueSlug: a.venueSlug,
          eventId: a.eventId
        });
      }
    } else if (isVenueRole(a.role)) {
      const key = `venue:${a.venueSlug ?? "default"}`;
      if (!seen.has(key)) {
        seen.add(key);
        workspaces.push({
          key,
          role: a.role,
          label: `Venue Portal (${a.venueSlug ?? "Assigned Venue"})`,
          path: "/venue-portal",
          organizationId: a.organizationId,
          venueSlug: a.venueSlug,
          eventId: null
        });
      }
    } else if (isStaffRole(a.role)) {
      const key = `staff:${a.eventId ?? "default"}:${a.role}`;
      if (!seen.has(key)) {
        seen.add(key);
        workspaces.push({
          key,
          role: a.role,
          label: `${a.role === "box_office" ? "Box Office" : "Gate Check-In"} (${a.eventId ?? "Assigned Event"})`,
          path: "/staff",
          organizationId: a.organizationId,
          venueSlug: a.venueSlug,
          eventId: a.eventId
        });
      }
    }
  }

  // Every authenticated user also has access to their attendee account & ticket wallet
  workspaces.push({
    key: "attendee:account",
    role: "attendee",
    label: "Attendee Account & Tickets",
    path: "/account",
    organizationId: null,
    venueSlug: null,
    eventId: null
  });

  const defaultWorkspacePath = workspaces[0]?.path ?? "/account";
  return { workspaces, defaultWorkspacePath };
}

function mapUserRow(row: Record<string, unknown>): UserAccount {
  return {
    id: String(row.id),
    email: row.email ? String(row.email) : null,
    fullName: String(row.full_name),
    phone: row.phone ? String(row.phone) : null,
    phoneVerifiedAt: row.phone_verified_at ? new Date(String(row.phone_verified_at)).toISOString() : null,
    preferredCitySlug: String(row.preferred_city_slug ?? "bengaluru"),
    favoriteCategories: (row.favorite_categories_json as string[]) ?? [],
    status: (row.status as UserAccount["status"]) ?? "ACTIVE",
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function mapRoleRow(row: Record<string, unknown>): RoleAssignmentRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    role: row.role as RoleAssignmentRecord["role"],
    organizationId: row.organization_id ? String(row.organization_id) : null,
    venueSlug: row.venue_slug ? String(row.venue_slug) : null,
    eventId: row.event_id ? String(row.event_id) : null,
    grantedBy: row.granted_by ? String(row.granted_by) : null,
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

export class OtpError extends Error {
  status: number;
  code: string;
  retryAfterSeconds?: number;

  constructor(message: string, status: number, code: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function shouldExposePreviewSyntheticOtp(phone: string): boolean {
  return isNonProductionEnvironment() && SYNTHETIC_QA_PHONES.has(phone);
}

export async function requestOtpChallenge(
  rawInput: unknown,
  clientIp: string
): Promise<OtpRequestResult> {
  const input = otpRequestSchema.parse(rawInput);
  const phone = normalizePhoneNumber(input.phone, input.countryCode);

  if (!checkRateLimit(`otp_ip:${clientIp}`, 15, 10 * 60_000)) {
    throw new OtpError("Too many OTP requests from this network. Please wait a few minutes.", 429, "RATE_LIMITED_IP", 60);
  }
  if (!checkRateLimit(`otp_phone:${phone}`, 5, 10 * 60_000)) {
    throw new OtpError("Too many OTP requests for this phone number. Please wait before trying again.", 429, "RATE_LIMITED_PHONE", 60);
  }

  const challengeId = `otp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const code = generateSixDigitOtp();
  const otpHash = hashOtpCode(challengeId, code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);
  const purpose: OtpPurpose = input.purpose;

  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    const record: MemoryOtpChallengeRecord = {
      id: challengeId,
      phone,
      otpHash,
      purpose,
      attempts: 0,
      maxAttempts: OTP_MAX_ATTEMPTS,
      resendCount: 0,
      lastSentAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      consumedAt: null,
      createdIp: clientIp,
      createdAt: now.toISOString()
    };
    store.otpChallenges.unshift(record);
  } else {
    await ensureSchemaBootstrapped(pool);
    await pool.query(
      `INSERT INTO auth_otp_challenges (id, phone, otp_hash, purpose, attempts, max_attempts, resend_count, last_sent_at, expires_at, created_ip, created_at)
       VALUES ($1,$2,$3,$4,0,$5,0,$6,$7,$8,$6)`,
      [challengeId, phone, otpHash, purpose, OTP_MAX_ATTEMPTS, now.toISOString(), expiresAt.toISOString(), clientIp]
    );
  }

  const provider = getSmsOtpProvider();
  await provider.sendOtp({ phone, code, ttlSeconds: OTP_TTL_SECONDS, requestId: challengeId });

  return {
    challengeId,
    maskedPhone: maskPhoneNumber(phone),
    expiresInSeconds: OTP_TTL_SECONDS,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    message: "If this phone number can receive SMS, a 6-digit verification code has been sent.",
    ...(shouldExposePreviewSyntheticOtp(phone) ? { previewSyntheticOtp: code } : {})
  };
}

export async function resendOtpChallenge(
  rawInput: unknown,
  clientIp: string
): Promise<OtpRequestResult> {
  const input = otpResendSchema.parse(rawInput);

  if (!checkRateLimit(`otp_ip:${clientIp}`, 15, 10 * 60_000)) {
    throw new OtpError("Too many OTP requests from this network. Please wait a few minutes.", 429, "RATE_LIMITED_IP", 60);
  }

  const now = new Date();
  const nextCode = generateSixDigitOtp();
  const nextHash = hashOtpCode(input.challengeId, nextCode);
  const nextExpiry = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);
  let phone = "";

  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    const ch = store.otpChallenges.find((c) => c.id === input.challengeId);
    if (!ch || ch.consumedAt) {
      throw new OtpError("Verification session not found or already used. Please request a new OTP.", 400, "CHALLENGE_INVALID");
    }
    if (new Date(ch.expiresAt).getTime() <= now.getTime()) {
      throw new OtpError("This OTP session has expired. Please request a new code.", 400, "OTP_EXPIRED");
    }
    const elapsedSec = Math.floor((now.getTime() - new Date(ch.lastSentAt).getTime()) / 1000);
    if (elapsedSec < OTP_RESEND_COOLDOWN_SECONDS) {
      const wait = OTP_RESEND_COOLDOWN_SECONDS - elapsedSec;
      throw new OtpError(`Please wait ${wait}s before requesting another OTP.`, 429, "RESEND_COOLDOWN", wait);
    }
    if (ch.resendCount >= OTP_MAX_RESENDS) {
      throw new OtpError("Maximum resend limit reached. Please start a new login attempt.", 429, "RESEND_LIMIT");
    }
    if (!checkRateLimit(`otp_phone:${ch.phone}`, 5, 10 * 60_000)) {
      throw new OtpError("Too many OTP requests for this phone number. Please wait before trying again.", 429, "RATE_LIMITED_PHONE", 60);
    }
    ch.otpHash = nextHash;
    ch.attempts = 0;
    ch.resendCount += 1;
    ch.lastSentAt = now.toISOString();
    ch.expiresAt = nextExpiry.toISOString();
    phone = ch.phone;
  } else {
    await ensureSchemaBootstrapped(pool);
    const res = await pool.query("SELECT * FROM auth_otp_challenges WHERE id = $1 LIMIT 1", [input.challengeId]);
    if (res.rowCount === 0 || res.rows[0].consumed_at) {
      throw new OtpError("Verification session not found or already used. Please request a new OTP.", 400, "CHALLENGE_INVALID");
    }
    const row = res.rows[0];
    if (new Date(String(row.expires_at)).getTime() <= now.getTime()) {
      throw new OtpError("This OTP session has expired. Please request a new code.", 400, "OTP_EXPIRED");
    }
    const elapsedSec = Math.floor((now.getTime() - new Date(String(row.last_sent_at)).getTime()) / 1000);
    if (elapsedSec < OTP_RESEND_COOLDOWN_SECONDS) {
      const wait = OTP_RESEND_COOLDOWN_SECONDS - elapsedSec;
      throw new OtpError(`Please wait ${wait}s before requesting another OTP.`, 429, "RESEND_COOLDOWN", wait);
    }
    if (Number(row.resend_count) >= OTP_MAX_RESENDS) {
      throw new OtpError("Maximum resend limit reached. Please start a new login attempt.", 429, "RESEND_LIMIT");
    }
    phone = String(row.phone);
    if (!checkRateLimit(`otp_phone:${phone}`, 5, 10 * 60_000)) {
      throw new OtpError("Too many OTP requests for this phone number. Please wait before trying again.", 429, "RATE_LIMITED_PHONE", 60);
    }
    await pool.query(
      `UPDATE auth_otp_challenges
       SET otp_hash = $2, attempts = 0, resend_count = resend_count + 1, last_sent_at = $3, expires_at = $4
       WHERE id = $1`,
      [input.challengeId, nextHash, now.toISOString(), nextExpiry.toISOString()]
    );
  }

  const provider = getSmsOtpProvider();
  await provider.sendOtp({ phone, code: nextCode, ttlSeconds: OTP_TTL_SECONDS, requestId: input.challengeId });

  return {
    challengeId: input.challengeId,
    maskedPhone: maskPhoneNumber(phone),
    expiresInSeconds: OTP_TTL_SECONDS,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    message: "A new 6-digit verification code has been sent.",
    ...(shouldExposePreviewSyntheticOtp(phone) ? { previewSyntheticOtp: nextCode } : {})
  };
}

export async function verifyOtpChallenge(rawInput: unknown): Promise<OtpVerifyResult> {
  const input = otpVerifySchema.parse(rawInput);
  const now = new Date();
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(token);
  const sessionId = `ses_${crypto.randomUUID().slice(0, 12)}`;
  const sessionExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const orgs = await listOrganizations();
  const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    const ch = store.otpChallenges.find((c) => c.id === input.challengeId);
    if (!ch) {
      throw new OtpError("Verification session not found. Please request a new OTP.", 400, "CHALLENGE_INVALID");
    }
    if (ch.consumedAt) {
      throw new OtpError("This verification code has already been used. Please request a new OTP.", 400, "OTP_REPLAYED");
    }
    if (new Date(ch.expiresAt).getTime() <= now.getTime()) {
      throw new OtpError("This OTP has expired. Please request a new verification code.", 400, "OTP_EXPIRED");
    }
    if (ch.attempts >= ch.maxAttempts) {
      throw new OtpError("Too many incorrect OTP attempts. Please request a new code.", 429, "ATTEMPTS_EXCEEDED");
    }
    if (!verifyOtpHash(ch.id, input.code, ch.otpHash)) {
      ch.attempts += 1;
      const remaining = Math.max(0, ch.maxAttempts - ch.attempts);
      throw new OtpError(
        remaining > 0 ? `Invalid OTP. ${remaining} attempt(s) remaining.` : "Too many incorrect OTP attempts. Please request a new code.",
        401,
        remaining > 0 ? "OTP_INVALID" : "ATTEMPTS_EXCEEDED"
      );
    }

    // Consume challenge atomically
    ch.consumedAt = now.toISOString();

    let existing = store.users.find((u) => u.phone === ch.phone);
    let isNewUser = false;
    if (!existing) {
      isNewUser = true;
      const userId = `usr_${crypto.randomUUID().slice(0, 12)}`;
      const fullName = input.fullName?.trim() || "NIGHTLIFEZ Member";
      existing = {
        id: userId,
        email: input.email ? input.email.toLowerCase() : null,
        passwordHash: null,
        fullName,
        phone: ch.phone,
        phoneVerifiedAt: now.toISOString(),
        preferredCitySlug: input.preferredCitySlug ?? "bengaluru",
        favoriteCategories: ["concerts", "dining"],
        status: "ACTIVE",
        createdAt: now.toISOString()
      };
      store.users.push(existing);
      store.roleAssignments.push({
        id: `ra_${crypto.randomUUID().slice(0, 10)}`,
        userId,
        role: "attendee",
        organizationId: null,
        venueSlug: null,
        eventId: null,
        grantedBy: null,
        createdAt: now.toISOString()
      });
    } else {
      if (existing.status === "SUSPENDED") {
        throw new OtpError("This account has been suspended.", 403, "ACCOUNT_SUSPENDED");
      }
      existing.phoneVerifiedAt = now.toISOString();
    }

    store.sessions.push({
      id: sessionId,
      userId: existing.id,
      tokenHash,
      expiresAt: sessionExpiresAt,
      createdAt: now.toISOString()
    });

    const assignments = store.roleAssignments.filter((r) => r.userId === existing.id);
    const { passwordHash: _ignored, ...user } = existing;
    const { workspaces, defaultWorkspacePath } = resolveWorkspaces(assignments, orgMap);
    return {
      user,
      assignments,
      roles: extractRolesFromAssignments(assignments),
      workspaces,
      defaultWorkspacePath,
      token,
      isNewUser,
      needsOnboarding: isNewUser && (!input.fullName || user.fullName === "NIGHTLIFEZ Member")
    };
  }

  await ensureSchemaBootstrapped(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const chRes = await client.query(
      "SELECT * FROM auth_otp_challenges WHERE id = $1 FOR UPDATE",
      [input.challengeId]
    );
    if (chRes.rowCount === 0) {
      throw new OtpError("Verification session not found. Please request a new OTP.", 400, "CHALLENGE_INVALID");
    }
    const ch = chRes.rows[0];
    if (ch.consumed_at) {
      throw new OtpError("This verification code has already been used. Please request a new OTP.", 400, "OTP_REPLAYED");
    }
    if (new Date(String(ch.expires_at)).getTime() <= now.getTime()) {
      throw new OtpError("This OTP has expired. Please request a new verification code.", 400, "OTP_EXPIRED");
    }
    const attempts = Number(ch.attempts);
    const maxAttempts = Number(ch.max_attempts);
    if (attempts >= maxAttempts) {
      throw new OtpError("Too many incorrect OTP attempts. Please request a new code.", 429, "ATTEMPTS_EXCEEDED");
    }

    if (!verifyOtpHash(String(ch.id), input.code, String(ch.otp_hash))) {
      await client.query(
        "UPDATE auth_otp_challenges SET attempts = attempts + 1 WHERE id = $1",
        [ch.id]
      );
      await client.query("COMMIT");
      const remaining = Math.max(0, maxAttempts - (attempts + 1));
      throw new OtpError(
        remaining > 0 ? `Invalid OTP. ${remaining} attempt(s) remaining.` : "Too many incorrect OTP attempts. Please request a new code.",
        401,
        remaining > 0 ? "OTP_INVALID" : "ATTEMPTS_EXCEEDED"
      );
    }

    // Atomic replay protection
    const consumeRes = await client.query(
      "UPDATE auth_otp_challenges SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL RETURNING phone",
      [ch.id]
    );
    if (consumeRes.rowCount === 0) {
      throw new OtpError("This verification code has already been used.", 400, "OTP_REPLAYED");
    }
    const phone = String(consumeRes.rows[0].phone);

    const existingRes = await client.query("SELECT * FROM users WHERE phone = $1 LIMIT 1", [phone]);
    let isNewUser = false;
    let userRow: Record<string, unknown>;

    if (existingRes.rowCount === 0) {
      isNewUser = true;
      const userId = `usr_${crypto.randomUUID().slice(0, 12)}`;
      const fullName = input.fullName?.trim() || "NIGHTLIFEZ Member";
      const emailLower = input.email ? input.email.toLowerCase() : null;
      const uIns = await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, phone, phone_verified_at, preferred_city_slug, favorite_categories_json, status)
         VALUES ($1,$2,NULL,$3,$4,NOW(),$5,$6::jsonb,'ACTIVE') RETURNING *`,
        [userId, emailLower, fullName, phone, input.preferredCitySlug ?? "bengaluru", JSON.stringify(["concerts", "dining"])]
      );
      userRow = uIns.rows[0];
      await client.query(
        `INSERT INTO role_assignments (id, user_id, role) VALUES ($1, $2, 'attendee')`,
        [`ra_${crypto.randomUUID().slice(0, 10)}`, userId]
      );
    } else {
      userRow = existingRes.rows[0];
      if (String(userRow.status) === "SUSPENDED") {
        throw new OtpError("This account has been suspended.", 403, "ACCOUNT_SUSPENDED");
      }
      const upd = await client.query(
        "UPDATE users SET phone_verified_at = NOW() WHERE id = $1 RETURNING *",
        [userRow.id]
      );
      userRow = upd.rows[0];
    }

    const user = mapUserRow(userRow);

    // One-time first-admin claim. The verified phone must match the explicitly
    // configured Production phone. An advisory transaction lock prevents two
    // simultaneous OTP verifications from creating competing first admins.
    if (matchesInitialAdminPhone(phone)) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        ["nightlifez:bootstrap:initial-platform-admin"]
      );
      const activeAdminRes = await client.query(
        `SELECT u.id
         FROM role_assignments ra
         JOIN users u ON u.id = ra.user_id
         WHERE ra.role = 'platform_super_admin'
           AND u.status <> 'SUSPENDED'
         LIMIT 1`
      );
      const existingAdminId = activeAdminRes.rows[0]?.id as string | undefined;
      const claimRes = await client.query(
        `INSERT INTO platform_bootstrap_claims (bootstrap_key, user_id)
         VALUES ($1, $2)
         ON CONFLICT (bootstrap_key) DO NOTHING
         RETURNING bootstrap_key`,
        ["initial_platform_admin", existingAdminId ?? user.id]
      );

      if (claimRes.rowCount && !existingAdminId) {
        await client.query(
          `INSERT INTO role_assignments (id, user_id, role, granted_by)
           VALUES ($1, $2, 'platform_super_admin', $3)`,
          ["ra_" + crypto.randomUUID().slice(0, 12), user.id, user.id]
        );
        await client.query(
          `INSERT INTO audit_logs
            (id, actor_user_id, actor_email, actor_role, action, target_type, target_id, before_json, after_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
          [
            "aud_" + crypto.randomUUID().slice(0, 12),
            user.id,
            user.email ?? user.phone,
            "platform_super_admin",
            "BOOTSTRAP_INITIAL_ADMIN",
            "user",
            user.id,
            JSON.stringify({ roles: ["attendee"] }),
            JSON.stringify({ roles: ["attendee", "platform_super_admin"] })
          ]
        );
      }
    }

    await client.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)",
      [sessionId, user.id, tokenHash, sessionExpiresAt]
    );
    const raRes = await client.query("SELECT * FROM role_assignments WHERE user_id = $1", [user.id]);
    await client.query("COMMIT");

    const assignments = raRes.rows.map(mapRoleRow);
    const { workspaces, defaultWorkspacePath } = resolveWorkspaces(assignments, orgMap);
    return {
      user,
      assignments,
      roles: extractRolesFromAssignments(assignments),
      workspaces,
      defaultWorkspacePath,
      token,
      isNewUser,
      needsOnboarding: isNewUser && (!input.fullName || user.fullName === "NIGHTLIFEZ Member")
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function attachWorkspacesToSession(session: AuthSessionView): Promise<AuthSessionView> {
  if (!session.user) return session;
  const orgs = await listOrganizations();
  const orgMap = new Map(orgs.map((o) => [o.id, o.name]));
  const { workspaces, defaultWorkspacePath } = resolveWorkspaces(session.assignments, orgMap);
  return { ...session, workspaces, defaultWorkspacePath };
}
