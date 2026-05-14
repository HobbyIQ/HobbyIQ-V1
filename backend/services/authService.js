const crypto = require('crypto');

const users = {};
const SEEDED_USERS = [
  {
    userId: 'admin-testing-hobbyiq',
    email: 'HobbyIQ',
    password: 'Baseball25',
    plan: 'all-star',
  },
  {
    userId: 'personal-justtheboysandcards',
    email: 'JusttheBoysandCards',
    password: 'Carolina23',
    plan: 'all-star',
  },
];

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const SESSION_SECRET = process.env.AUTH_SESSION_SECRET || 'hobbyiq-admin-testing-session-secret';

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function createSessionToken(userId) {
  const payload = Buffer.from(JSON.stringify({
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
    nonce: crypto.randomUUID(),
  })).toString('base64url');

  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSessionToken(sessionToken) {
  const [payload, signature] = String(sessionToken || '').split('.');
  if (!payload || !signature) return null;

  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
  const actualSignature = Buffer.from(signature, 'base64url');
  if (actualSignature.length !== expectedSignature.length) return null;
  if (!crypto.timingSafeEqual(actualSignature, expectedSignature)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.userId || typeof decoded.expiresAt !== 'number') return null;
    if (decoded.expiresAt <= Date.now()) return null;
    return { userId: decoded.userId, expiresAt: decoded.expiresAt };
  } catch {
    return null;
  }
}

function toAuthUser(user) {
  return {
    userId: user.userId,
    email: user.email,
    plan: user.plan,
    createdAt: user.createdAt,
    displayName: user.displayName || '',
  };
}

function seedUsers() {
  for (const seededUser of SEEDED_USERS) {
    users[seededUser.userId] = {
      userId: seededUser.userId,
      email: seededUser.email,
      passwordHash: hashPassword(seededUser.password),
      plan: seededUser.plan,
      createdAt: new Date().toISOString(),
    };
  }
}

function findUser(identifier) {
  const normalized = String(identifier || '').trim().toLowerCase();
  return Object.values(users).find((user) => user.email.trim().toLowerCase() === normalized);
}

seedUsers();

async function signIn(identifier, password) {
  if (!identifier || !password) {
    return { success: false, error: 'Username and password required' };
  }

  const user = findUser(identifier);
  if (!user || user.passwordHash !== hashPassword(password)) {
    return { success: false, error: 'Invalid credentials' };
  }

  const sessionId = createSessionToken(user.userId);
  return { success: true, user: toAuthUser(user), sessionId };
}

async function signOut() {
  return { success: true };
}

async function getUserBySession(sessionId) {
  const session = readSessionToken(sessionId);
  if (!session) return null;

  const user = users[session.userId];
  return user ? toAuthUser(user) : null;
}

/**
 * Upsert (or create) a user keyed on Apple's stable `sub` claim and return a
 * fresh session token. Apple only sends `email`/`fullName` on the FIRST
 * sign-in for a given app; we persist whatever we get on first contact and
 * never overwrite a stored email with null on subsequent calls.
 */
async function signInWithApple({ sub, email, displayName }) {
  if (!sub || typeof sub !== 'string') {
    return { success: false, error: 'apple_sub_required' };
  }

  const userId = `apple:${sub}`;
  let user = users[userId];
  if (!user) {
    user = {
      userId,
      email: email || `${userId}@apple.local`,
      passwordHash: '',
      plan: 'free',
      createdAt: new Date().toISOString(),
      displayName: displayName || '',
      provider: 'apple',
      appleSub: sub,
    };
    users[userId] = user;
  } else {
    if (email && (!user.email || user.email.endsWith('@apple.local'))) {
      user.email = email;
    }
    if (displayName && !user.displayName) {
      user.displayName = displayName;
    }
  }

  const sessionId = createSessionToken(user.userId);
  return { success: true, user: toAuthUser(user), sessionId };
}

module.exports = { signIn, signOut, getUserBySession, signInWithApple };
