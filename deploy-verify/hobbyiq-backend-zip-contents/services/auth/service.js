"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signUp = signUp;
exports.signIn = signIn;
exports.signOut = signOut;
exports.getSession = getSession;
exports.getUserBySession = getUserBySession;
exports.getUserById = getUserById;
exports.setUserPlan = setUserPlan;
const crypto_1 = __importDefault(require("crypto"));
// In-memory user/session store (replace with DB in prod)
const users = {};
const sessions = {};
function hashPassword(password) {
    return crypto_1.default.createHash("sha256").update(password).digest("hex");
}
function generateId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
async function signUp(email, password) {
    if (!email || !password)
        return { success: false, error: "Email and password required" };
    if (Object.values(users).find(u => u.email === email))
        return { success: false, error: "Email already registered" };
    const userId = generateId();
    const user = {
        userId,
        email,
        passwordHash: hashPassword(password),
        plan: "free",
        createdAt: new Date().toISOString(),
    };
    users[userId] = user;
    return { success: true, user };
}
async function signIn(email, password) {
    const user = Object.values(users).find(u => u.email === email);
    if (!user)
        return { success: false, error: "Invalid credentials" };
    if (user.passwordHash !== hashPassword(password))
        return { success: false, error: "Invalid credentials" };
    const sessionId = generateId();
    const session = {
        sessionId,
        userId: user.userId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(), // 7 days
    };
    sessions[sessionId] = session;
    return { success: true, user, sessionId };
}
async function signOut(sessionId) {
    delete sessions[sessionId];
    return { success: true };
}
async function getSession(sessionId) {
    return sessions[sessionId] || null;
}
async function getUserBySession(sessionId) {
    const session = await getSession(sessionId);
    if (!session)
        return null;
    return users[session.userId] || null;
}
async function getUserById(userId) {
    return users[userId] || null;
}
async function setUserPlan(userId, plan) {
    const user = users[userId];
    if (!user)
        return false;
    user.plan = plan;
    return true;
}
