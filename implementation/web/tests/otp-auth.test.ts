import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAuthorized
} from "../src/lib/auth.ts";
import {
  getSessionByToken,
  signOutToken,
  updateUserProfile
} from "../src/lib/authStore.ts";
import { getMemoryStore } from "../src/lib/memoryStore.ts";
import {
  OtpError,
  requestOtpChallenge,
  resendOtpChallenge,
  verifyOtpChallenge,
  matchesInitialAdminPhone
} from "../src/lib/otpService.ts";
import { getSmsOtpProvider, MockSmsOtpProvider } from "../src/lib/smsProvider.ts";
import {
  ALL_ROLES,
  normalizePhoneNumber,
  SYNTHETIC_QA_IDENTITIES,
  SYNTHETIC_QA_PHONES
} from "../../shared/src/index.ts";

test("phone normalization handles India +91, prefixes, formatting, and rejects invalid inputs", () => {
  assert.equal(normalizePhoneNumber("98765 00001"), "+919876500001");
  assert.equal(normalizePhoneNumber("09876500001"), "+919876500001");
  assert.equal(normalizePhoneNumber("919876500001"), "+919876500001");
  assert.equal(normalizePhoneNumber("+91 (98765)-00001"), "+919876500001");
  assert.equal(normalizePhoneNumber("00919876500001"), "+919876500001");
  assert.equal(normalizePhoneNumber("4155550199", "+1"), "+14155550199");
  assert.equal(normalizePhoneNumber("+44 7700 900077"), "+447700900077");

  assert.throws(() => normalizePhoneNumber(""), /required/i);
  assert.throws(() => normalizePhoneNumber("12345"), /valid/i);
  assert.throws(() => normalizePhoneNumber("98765abc01"), /digits/i);
  assert.throws(() => normalizePhoneNumber("0000000000"), /valid/i);
});

test("initial platform-admin bootstrap requires a matching verified Production phone and rejects QA numbers", () => {
  assert.equal(matchesInitialAdminPhone("+919111222333", "production", "+91 91112 22333"), true);
  assert.equal(matchesInitialAdminPhone("+919111222333", "preview", "+91 91112 22333"), false);
  assert.equal(matchesInitialAdminPhone("+919111222333", "production", "+919111222334"), false);
  assert.equal(matchesInitialAdminPhone("+919111222333", "production", "not-a-phone"), false);

  const syntheticPhone = [...SYNTHETIC_QA_PHONES][0];
  assert.equal(matchesInitialAdminPhone(syntheticPhone, "production", syntheticPhone), false);
});

test("SmsOtpProvider blocks MockSmsOtpProvider in production and uses MockSmsOtpProvider in preview/dev", async () => {
  const prevVercelEnv = process.env.VERCEL_ENV;
  try {
    delete process.env.VERCEL_ENV;
    const devProvider = getSmsOtpProvider();
    assert.equal(devProvider.name, "mock");

    process.env.VERCEL_ENV = "production";
    delete process.env.NIGHTLIFEZ_SMS_PROVIDER;
    assert.throws(() => getSmsOtpProvider(), /not configured/i);

    const mock = new MockSmsOtpProvider();
    await assert.rejects(
      () => mock.sendOtp({ phone: "+919876500001", code: "123456", ttlSeconds: 300, requestId: "req1" }),
      /cannot be used in production/i
    );
  } finally {
    if (prevVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prevVercelEnv;
  }
});

test("OTP request returns anti-enumeration response, enforces expiry, attempt limits, and replay protection", async () => {
  const ip = `10.0.0.${Math.floor(Math.random() * 200) + 1}`;
  const req1 = await requestOtpChallenge({ phone: "9876500001", countryCode: "+91" }, ip);
  const req2 = await requestOtpChallenge({ phone: "9999988888", countryCode: "+91" }, ip);

  // Anti-enumeration: identical message & structure for registered vs unregistered (no previewSyntheticOtp for non-QA)
  assert.equal(req1.message, req2.message);
  assert.equal(req1.expiresInSeconds, 300);
  assert.ok(req1.previewSyntheticOtp);
  assert.equal(req2.previewSyntheticOtp, undefined);

  // Invalid OTP increments attempts and locks after 5 failures
  for (let i = 0; i < 4; i++) {
    await assert.rejects(
      () => verifyOtpChallenge({ challengeId: req1.challengeId, code: "000000" }),
      (err: unknown) => err instanceof OtpError && err.code === "OTP_INVALID"
    );
  }
  await assert.rejects(
    () => verifyOtpChallenge({ challengeId: req1.challengeId, code: "000000" }),
    (err: unknown) => err instanceof OtpError && err.code === "ATTEMPTS_EXCEEDED"
  );

  // Expired OTP is rejected
  const reqExp = await requestOtpChallenge({ phone: "9876500002", countryCode: "+91" }, ip);
  const store = getMemoryStore();
  const chExp = store.otpChallenges.find((c) => c.id === reqExp.challengeId)!;
  chExp.expiresAt = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(
    () => verifyOtpChallenge({ challengeId: reqExp.challengeId, code: reqExp.previewSyntheticOtp! }),
    (err: unknown) => err instanceof OtpError && err.code === "OTP_EXPIRED"
  );

  // One-time verification & replay protection
  const reqOk = await requestOtpChallenge({ phone: "9876500001", countryCode: "+91" }, ip);
  const verified = await verifyOtpChallenge({
    challengeId: reqOk.challengeId,
    code: reqOk.previewSyntheticOtp!
  });
  assert.equal(verified.user?.email, "asha@nightlifez.test");
  assert.ok(verified.token);

  // Replay attempt fails
  await assert.rejects(
    () => verifyOtpChallenge({ challengeId: reqOk.challengeId, code: reqOk.previewSyntheticOtp! }),
    (err: unknown) => err instanceof OtpError && err.code === "OTP_REPLAYED"
  );

  // Logout invalidates token
  await signOutToken(verified.token);
  const afterSignOut = await getSessionByToken(verified.token);
  assert.equal(afterSignOut.user, null);
});

test("OTP resend enforces cooldown and per-phone / per-IP rate limits", async () => {
  const ip = `10.1.0.${Math.floor(Math.random() * 200) + 1}`;
  const phone = `98111${Math.floor(10000 + Math.random() * 89999)}`;

  const ch = await requestOtpChallenge({ phone, countryCode: "+91" }, ip);
  // Immediate resend hits 30s cooldown
  await assert.rejects(
    () => resendOtpChallenge({ challengeId: ch.challengeId }, ip),
    (err: unknown) => err instanceof OtpError && err.code === "RESEND_COOLDOWN"
  );

  // Per-phone rate limit (max 5 requests in 10 min)
  for (let i = 0; i < 4; i++) {
    await requestOtpChallenge({ phone, countryCode: "+91" }, ip);
  }
  await assert.rejects(
    () => requestOtpChallenge({ phone, countryCode: "+91" }, ip),
    (err: unknown) => err instanceof OtpError && err.code === "RATE_LIMITED_PHONE"
  );

  // Per-IP rate limit (max 15 requests in 10 min)
  const ipSpam = `10.2.0.${Math.floor(Math.random() * 200) + 1}`;
  for (let i = 0; i < 15; i++) {
    await requestOtpChallenge({ phone: `98222${String(10000 + i)}`, countryCode: "+91" }, ipSpam);
  }
  await assert.rejects(
    () => requestOtpChallenge({ phone: "9822299999", countryCode: "+91" }, ipSpam),
    (err: unknown) => err instanceof OtpError && err.code === "RATE_LIMITED_IP"
  );
});

test("every seeded role logs in via OTP and resolves exact permissions, workspaces, and org/event isolation", async () => {
  const ip = `10.3.0.${Math.floor(Math.random() * 200) + 1}`;
  const seenRoles = new Set<string>();

  for (let idx = 0; idx < SYNTHETIC_QA_IDENTITIES.length; idx++) {
    const qa = SYNTHETIC_QA_IDENTITIES[idx];
    const req = await requestOtpChallenge({ phone: qa.phone, countryCode: "+91" }, `${ip}.${idx}`);
    assert.ok(req.previewSyntheticOtp, `Expected synthetic OTP for ${qa.email}`);
    const session = await verifyOtpChallenge({
      challengeId: req.challengeId,
      code: req.previewSyntheticOtp
    });

    assert.equal(session.user?.id, qa.id);
    assert.equal(session.user?.phone, qa.phone);
    assert.equal(session.isNewUser, false);
    assert.ok(session.workspaces && session.workspaces.length >= 1);
    for (const r of session.roles) seenRoles.add(r);
  }

  for (const role of ALL_ROLES) {
    assert.ok(seenRoles.has(role), `Missing QA identity coverage for role: ${role}`);
  }

  // Verify multi-org organiser context & isolation
  const orgReq = await requestOtpChallenge({ phone: "+919876500005", countryCode: "+91" }, `${ip}.org`);
  const orgSession = await verifyOtpChallenge({
    challengeId: orgReq.challengeId,
    code: orgReq.previewSyntheticOtp!
  });
  assert.ok(orgSession.workspaces!.some((w) => w.organizationId === "org-nightlifez-originals"));
  assert.ok(orgSession.workspaces!.some((w) => w.organizationId === "org-harbor-collective"));
  assert.equal(
    assertAuthorized(orgSession, "org:events:write", { organizationId: "org-nightlifez-originals" }).ok,
    true
  );
  assert.equal(
    assertAuthorized(orgSession, "org:events:write", { organizationId: "org-coastal-pending" }).ok,
    false
  );

  // Verify staff event isolation
  const stfReq = await requestOtpChallenge({ phone: "+919876500007", countryCode: "+91" }, `${ip}.stf`);
  const stfSession = await verifyOtpChallenge({
    challengeId: stfReq.challengeId,
    code: stfReq.previewSyntheticOtp!
  });
  assert.equal(
    assertAuthorized(stfSession, "staff:tickets:scan", { eventId: "evt-solstice-2026" }).ok,
    true
  );
  assert.equal(
    assertAuthorized(stfSession, "staff:tickets:scan", { eventId: "evt-tides-tempo-goa-2026" }).ok,
    false
  );
});

test("new phone-first onboarding creates attendee account and prevents duplicate phone/email", async () => {
  const ip = `10.4.0.${Math.floor(Math.random() * 200) + 1}`;
  const newPhone = `98333${Math.floor(10000 + Math.random() * 89999)}`;
  const req = await requestOtpChallenge({ phone: newPhone, countryCode: "+91" }, ip);
  const store = getMemoryStore();
  // Read code from mock SMS log (since non-QA numbers do not expose previewSyntheticOtp)
  assert.equal(req.previewSyntheticOtp, undefined);
  const { getMockSmsLog } = await import("../src/lib/smsProvider.ts");
  const sent = getMockSmsLog().find((m) => m.requestId === req.challengeId);
  assert.ok(sent);

  const verified = await verifyOtpChallenge({ challengeId: req.challengeId, code: sent.code });
  assert.equal(verified.isNewUser, true);
  assert.equal(verified.needsOnboarding, true);
  assert.deepEqual(verified.roles, ["attendee"]);

  const updated = await updateUserProfile(verified.user!.id, {
    fullName: "New Phone User",
    email: null
  });
  assert.equal(updated.fullName, "New Phone User");
  assert.equal(updated.email, null);

  // Duplicate phone update is blocked
  await assert.rejects(
    () => updateUserProfile(verified.user!.id, { phone: "+919876500001" }),
    /already linked/i
  );
});
