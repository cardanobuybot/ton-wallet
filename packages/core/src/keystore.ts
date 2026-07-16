// Шифрование мнемоники паролем. Только WebCrypto (браузер и Node >= 22):
// PBKDF2-SHA256 (>= 600k итераций) → AES-256-GCM.
// В постоянное хранилище попадает ТОЛЬКО этот конверт; расшифрованная
// мнемоника и ключи живут в памяти и зануляются при локе.

export const KDF_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

// Конверт версионирован, чтобы позже сменить KDF без потери данных.
export interface KeystoreEnvelope {
  version: 1;
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string };
  cipher: { name: 'AES-256-GCM'; iv: string };
  ciphertext: string;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromBase64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptMnemonic(
  words: string[],
  password: string,
): Promise<KeystoreEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  const plaintext = new TextEncoder().encode(words.join(' '));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  plaintext.fill(0);
  return {
    version: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: toBase64(salt) },
    cipher: { name: 'AES-256-GCM', iv: toBase64(iv) },
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptMnemonic(
  envelope: KeystoreEnvelope,
  password: string,
): Promise<string[]> {
  if (
    envelope.version !== 1 ||
    envelope.kdf.name !== 'PBKDF2-SHA256' ||
    envelope.cipher.name !== 'AES-256-GCM'
  ) {
    throw new Error('Неподдерживаемый формат хранилища');
  }
  const key = await deriveKey(password, fromBase64(envelope.kdf.salt), envelope.kdf.iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.cipher.iv) as BufferSource },
      key,
      fromBase64(envelope.ciphertext) as BufferSource,
    );
  } catch {
    // AES-GCM аутентифицирован: неверный пароль и повреждённые данные неразличимы.
    throw new Error('Неверный пароль или повреждённое хранилище');
  }
  return new TextDecoder().decode(plaintext).split(' ');
}
