import "server-only";

import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const ISSUER = "Paribelle OMS";

export function generateMfaSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function totp(email: string, secret: string) {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

/** A QR code image (data URL) for the authenticator app to scan. */
export async function mfaQrCode(email: string, secret: string): Promise<string> {
  const uri = totp(email, secret).toString();
  return QRCode.toDataURL(uri, { margin: 1, width: 240 });
}

/**
 * Accepts the current code and one step on either side, so a slow typer or a
 * slightly clock-skewed phone isn't locked out over one bad tick.
 */
export function verifyMfaToken(email: string, secret: string, token: string): boolean {
  const clean = token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  return totp(email, secret).validate({ token: clean, window: 1 }) !== null;
}
