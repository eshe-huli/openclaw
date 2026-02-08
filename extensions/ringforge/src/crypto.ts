/**
 * Ringforge Message Crypto — JWS/JWE client-side implementation
 *
 * Uses Node.js crypto (no external deps) for symmetric operations:
 * - JWS: HMAC-SHA256 (HS256) compact serialization
 * - JWE: dir + A256GCM compact serialization
 *
 * Compatible with Hub.Crypto (Elixir JOSE library).
 */

import { createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export type CryptoMode = "none" | "sign" | "encrypt" | "sign_encrypt";

export type CryptoMeta = {
  mode: CryptoMode;
  kid?: string;
  alg?: string;
  enc?: string;
};

export type ProtectedEnvelope = {
  jws?: string;
  jwe?: string;
  message?: Record<string, unknown>;
  crypto: CryptoMeta;
};

// ── Helpers ────────────────────────────────────────────────

function base64UrlEncode(data: Buffer | Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  return buf.toString("base64url");
}

function base64UrlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// ── JWS (HS256) ────────────────────────────────────────────

/**
 * Create a JWS compact token (HS256) from a payload.
 * Format: header.payload.signature
 */
export function jwsSign(
  payload: Record<string, unknown>,
  secret: Buffer,
  kid = "fleet_key",
): string {
  const header = { alg: "HS256", kid, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    payload,
    iat: now,
    nbf: now - 5,
    exp: now + 300, // 5 min
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const claimsB64 = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${claimsB64}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  const sigB64 = base64UrlEncode(signature);

  return `${headerB64}.${claimsB64}.${sigB64}`;
}

/**
 * Verify a JWS compact token (HS256) and extract the payload.
 */
export function jwsVerify(
  compact: string,
  secret: Buffer,
  opts: { checkExp?: boolean } = {},
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const checkExp = opts.checkExp !== false;
  const parts = compact.split(".");
  if (parts.length !== 3) return { ok: false, error: "invalid_format" };

  const [headerB64, claimsB64, sigB64] = parts;

  // Verify signature
  const signingInput = `${headerB64}.${claimsB64}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  const actual = base64UrlDecode(sigB64);

  if (!expected.equals(actual)) return { ok: false, error: "invalid_signature" };

  // Parse header
  try {
    const header = JSON.parse(base64UrlDecode(headerB64).toString());
    if (header.alg !== "HS256") return { ok: false, error: "unsupported_alg" };
  } catch {
    return { ok: false, error: "invalid_header" };
  }

  // Parse claims
  try {
    const claims = JSON.parse(base64UrlDecode(claimsB64).toString());
    const now = Math.floor(Date.now() / 1000);

    if (checkExp && typeof claims.exp === "number" && now > claims.exp) {
      return { ok: false, error: "expired" };
    }
    if (typeof claims.nbf === "number" && now < claims.nbf) {
      return { ok: false, error: "not_yet_valid" };
    }

    return { ok: true, payload: claims.payload };
  } catch {
    return { ok: false, error: "invalid_claims" };
  }
}

// ── JWE (dir + A256GCM) ───────────────────────────────────

/**
 * Create a JWE compact token using direct key + A256GCM.
 * Format: header.encryptedKey.iv.ciphertext.tag
 * For "dir" algorithm, encryptedKey is empty.
 */
export function jweEncrypt(
  payload: Record<string, unknown>,
  secret: Buffer,
  kid = "fleet_key",
): string {
  const header = { alg: "dir", enc: "A256GCM", kid, typ: "JWT" };
  const headerB64 = base64UrlEncode(JSON.stringify(header));

  const now = Math.floor(Date.now() / 1000);
  const plaintext = JSON.stringify({
    payload,
    iat: now,
    exp: now + 300,
  });

  // A256GCM: 12-byte IV, 16-byte tag
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);

  // AAD = protected header (base64url encoded)
  cipher.setAAD(Buffer.from(headerB64, "ascii"));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Compact: header..iv.ciphertext.tag (empty encrypted key for "dir")
  return `${headerB64}..${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}.${base64UrlEncode(tag)}`;
}

/**
 * Decrypt a JWE compact token using direct key + A256GCM.
 */
export function jweDecrypt(
  compact: string,
  secret: Buffer,
  opts: { checkExp?: boolean } = {},
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const checkExp = opts.checkExp !== false;
  const parts = compact.split(".");
  if (parts.length !== 5) return { ok: false, error: "invalid_format" };

  const [headerB64, _encKeyB64, ivB64, ciphertextB64, tagB64] = parts;

  // Parse header
  try {
    const header = JSON.parse(base64UrlDecode(headerB64).toString());
    if (header.alg !== "dir" || header.enc !== "A256GCM") {
      return { ok: false, error: "unsupported_alg_enc" };
    }
  } catch {
    return { ok: false, error: "invalid_header" };
  }

  try {
    const iv = base64UrlDecode(ivB64);
    const ciphertext = base64UrlDecode(ciphertextB64);
    const tag = base64UrlDecode(tagB64);

    const decipher = createDecipheriv("aes-256-gcm", secret, iv);
    decipher.setAAD(Buffer.from(headerB64, "ascii"));
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );

    const claims = JSON.parse(plaintext);
    const now = Math.floor(Date.now() / 1000);

    if (checkExp && typeof claims.exp === "number" && now > claims.exp) {
      return { ok: false, error: "expired" };
    }

    return { ok: true, payload: claims.payload };
  } catch {
    return { ok: false, error: "decrypt_failed" };
  }
}

// ── Combined Operations ────────────────────────────────────

/**
 * Protect a message according to the specified mode.
 */
export function protect(
  payload: Record<string, unknown>,
  secret: Buffer,
  mode: CryptoMode = "sign_encrypt",
  kid = "fleet_key",
): ProtectedEnvelope {
  switch (mode) {
    case "none":
      return { message: payload, crypto: { mode: "none" } };

    case "sign": {
      const jws = jwsSign(payload, secret, kid);
      return {
        message: payload,
        jws,
        crypto: { mode: "sign", kid, alg: "HS256" },
      };
    }

    case "encrypt": {
      const jwe = jweEncrypt(payload, secret, kid);
      return {
        jwe,
        crypto: { mode: "encrypt", kid, enc: "A256GCM" },
      };
    }

    case "sign_encrypt": {
      // Sign first, then encrypt the JWS
      const jws = jwsSign(payload, secret, kid);
      const jwe = jweEncrypt({ jws } as any, secret, kid);
      return {
        jwe,
        crypto: { mode: "sign_encrypt", kid, alg: "HS256", enc: "A256GCM" },
      };
    }
  }
}

/**
 * Unprotect a received message according to its crypto metadata.
 */
export function unprotect(
  envelope: ProtectedEnvelope,
  secret: Buffer,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const mode = envelope.crypto?.mode || "none";

  switch (mode) {
    case "none":
      return envelope.message
        ? { ok: true, payload: envelope.message }
        : { ok: false, error: "no_message" };

    case "sign":
      if (!envelope.jws) return { ok: false, error: "missing_jws" };
      return jwsVerify(envelope.jws, secret);

    case "encrypt":
      if (!envelope.jwe) return { ok: false, error: "missing_jwe" };
      return jweDecrypt(envelope.jwe, secret);

    case "sign_encrypt": {
      if (!envelope.jwe) return { ok: false, error: "missing_jwe" };
      const decrypted = jweDecrypt(envelope.jwe, secret);
      if (!decrypted.ok) return decrypted;
      const inner = decrypted.payload as { jws?: string };
      if (!inner.jws) return { ok: false, error: "missing_inner_jws" };
      return jwsVerify(inner.jws as string, secret);
    }

    default:
      return { ok: false, error: `unknown_mode: ${mode}` };
  }
}

/**
 * Decode a base64url-encoded 32-byte secret (from crypto:key response).
 */
export function decodeSecret(encoded: string): Buffer {
  return base64UrlDecode(encoded);
}
