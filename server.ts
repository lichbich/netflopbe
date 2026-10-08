import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import asyncHandler from 'express-async-handler';
import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { initDb } from './db';
import type { Database } from 'sqlite';
import type sqlite3 from 'sqlite3';

const app = express();
const port = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'netflop-secret-key-2026-auth-secure';

// Token generation & verification helpers using built-in crypto HMAC-SHA256
export function createToken(payload: { username: string; name?: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  // Long expiration: 30 days (persists until sign out)
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
  return `${header}.${data}.${signature}`;
}

export function verifyToken(token: string): { username: string; name?: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, data, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// State: Firebase vs SQLite fallback
let isFirebase = false;
let fbDb: admin.database.Database | null = null;
let membersRef: admin.database.Reference | null = null;
let usersRef: admin.database.Reference | null = null;
let sqliteDb: Database<sqlite3.Database, sqlite3.Statement> | null = null;

// Initialize Database (Firebase if config available, otherwise SQLite)
async function setupDatabase() {
  try {
    const serviceAccountJson = process.env.FIREBASE_PRIVATE_KEY_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FB_SERVICE_ACCOUNT;
    
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://unichat-acfc2-default-rtdb.firebaseio.com"
      });
      console.log("Firebase initialized via Single JSON ENV");
    } else if (process.env.FB_PRIVATE_KEY) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FB_PROJECT_ID,
          clientEmail: process.env.FB_CLIENT_EMAIL,
          privateKey: process.env.FB_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        databaseURL: "https://unichat-acfc2-default-rtdb.firebaseio.com"
      });
      console.log("Firebase initialized via Simple 3 ENVs");
    } else if (existsSync(path.resolve('./serviceAccountKey.json'))) {
      const serviceAccount = JSON.parse(readFileSync(path.resolve('./serviceAccountKey.json'), 'utf8'));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://unichat-acfc2-default-rtdb.firebaseio.com"
      });
      console.log("Firebase initialized via Local File");
    }
  } catch (error) {
    console.error("Firebase initialization failed:", error);
  }

  if (admin.apps.length > 0) {
    isFirebase = true;
    fbDb = admin.database();
    membersRef = fbDb.ref('members');
    usersRef = fbDb.ref('users');
    console.log("Using Firebase Realtime Database");

    // Seed default user lichdt in Firebase
    try {
      const lichdtSnap = await usersRef.child('lichdt').once('value');
      if (!lichdtSnap.exists()) {
        await usersRef.child('lichdt').set({
          username: 'lichdt',
          password: '389363',
          name: 'lichdt'
        });
        console.log("Default user lichdt seeded in Firebase");
      }
    } catch (err) {
      console.error("Failed to seed user in Firebase:", err);
    }

    // Seed initial members if empty
    try {
      const snapshot = await membersRef.once('value');
      if (!snapshot.exists()) {
        const initialMembers = [
          { id: '1', name: 'Chủ Account (Bạn)', startDate: new Date().toISOString().split('T')[0], initialBalance: 0 },
          ...Array.from({ length: 9 }, (_, i) => ({
            id: (i + 2).toString(),
            name: `Thành viên ${i + 1}`,
            startDate: new Date().toISOString().split('T')[0],
            initialBalance: 0
          }))
        ];
        const seedData: Record<string, any> = {};
        initialMembers.forEach(m => {
          seedData[m.id] = {
            name: m.name,
            startDate: m.startDate,
            initialBalance: m.initialBalance
          };
        });
        await membersRef.set(seedData);
        console.log('Firebase Database members seeded!');
      }
    } catch (err) {
      console.error("Failed to seed members in Firebase:", err);
    }
  } else {
    isFirebase = false;
    console.log("Firebase credentials not found. Initializing SQLite (netflop.db)...");
    sqliteDb = await initDb();
    console.log("SQLite (netflop.db) initialized successfully.");
  }
}

// Database ready promise
const dbReady = setupDatabase().catch((err) => {
  console.error("Database setup error:", err);
});

// Middleware: Require valid JWT token
const requireAuth = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized: Vui lòng đăng nhập' });
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: Phiên đăng nhập không hợp lệ hoặc đã hết hạn' });
  }
  req.user = user;
  next();
};

// ================= AUTH ROUTES =================

// Đăng nhập: POST /api/auth/login hoặc /api/login
app.post(['/api/auth/login', '/api/login'], asyncHandler(async (req: any, res: any) => {
  await dbReady;
  const { username, password } = req.body || {};
  
  if (!username || !password) {
    return res.status(400).json({ 
      success: false, 
      message: 'Vui lòng nhập tên đăng nhập và mật khẩu!' 
    });
  }

  const cleanUser = String(username).trim();
  const cleanPass = String(password).trim();

  let isValid = false;
  let displayName = cleanUser;

  // 1. Check default preset account: lichdt / 389363
  if (cleanUser === 'lichdt' && cleanPass === '389363') {
    isValid = true;
    displayName = 'lichdt';
  } else if (isFirebase && usersRef) {
    // 2. Check Firebase users
    const snap = await usersRef.child(cleanUser).once('value');
    if (snap.exists()) {
      const data = snap.val();
      if (data && String(data.password) === cleanPass) {
        isValid = true;
        displayName = data.name || data.username || cleanUser;
      }
    }
  } else if (sqliteDb) {
    // 3. Check SQLite users
    const userRow = await sqliteDb.get('SELECT * FROM users WHERE username = ?', [cleanUser]);
    if (userRow && String(userRow.password) === cleanPass) {
      isValid = true;
      displayName = userRow.name || userRow.username || cleanUser;
    }
  }

  if (!isValid) {
    return res.status(401).json({ 
      success: false, 
      message: 'Sai tên đăng nhập hoặc mật khẩu!' 
    });
  }

  const token = createToken({ username: cleanUser, name: displayName });
  
  res.json({
    success: true,
    token,
    user: {
      username: cleanUser,
      name: displayName
    }
  });
}));

// Kiểm tra phiên đăng nhập: GET /api/auth/me
app.get('/api/auth/me', asyncHandler(async (req: any, res: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ authenticated: false, message: 'Chưa có thông tin đăng nhập' });
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ authenticated: false, message: 'Phiên đăng nhập đã hết hạn' });
  }
  res.json({
    authenticated: true,
    user: {
      username: payload.username,
      name: payload.name || payload.username
    }
  });
}));

// Đăng xuất: POST /api/auth/logout
app.post(['/api/auth/logout', '/api/logout'], (req: any, res: any) => {
  res.json({ success: true, message: 'Đăng xuất thành công' });
});

// ================= MEMBER & PAYMENT ROUTES =================

app.get('/api/members', asyncHandler(async (req: any, res: any) => {
  await dbReady;
  
  if (isFirebase && membersRef) {
    const snapshot = await membersRef.once('value');
    const data = snapshot.val() || {};
    
    const members = Object.entries(data).map(([id, member]: [string, any]) => {
      let payments: any[] = [];
      if (member.payments) {
        payments = Object.entries(member.payments).map(([pid, p]: [string, any]) => ({
          ...(p as object),
          id: pid
        }));
        payments.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      }
      
      return {
        ...member,
        id,
        payments
      };
    });

    return res.json(members);
  }

  if (sqliteDb) {
    const members = await sqliteDb.all('SELECT * FROM members');
    for (const m of members) {
      const payments = await sqliteDb.all(
        'SELECT id, amount, date FROM payments WHERE memberId = ? ORDER BY date DESC',
        [m.id]
      );
      m.payments = payments || [];
    }
    return res.json(members);
  }

  res.json([]);
}));

app.put('/api/members/:id', asyncHandler(async (req: any, res: any) => {
  await dbReady;
  const { id } = req.params;
  const { name, initialBalance, startDate } = req.body;

  if (isFirebase && membersRef) {
    const memberRef = membersRef.child(id);
    await memberRef.update({
      name,
      initialBalance: Number(initialBalance),
      startDate
    });

    const updated = (await memberRef.once('value')).val();
    return res.json({ ...updated, id });
  }

  if (sqliteDb) {
    await sqliteDb.run(
      'UPDATE members SET name = ?, initialBalance = ?, startDate = ? WHERE id = ?',
      [name, Number(initialBalance) || 0, startDate, id]
    );
    const updated = await sqliteDb.get('SELECT * FROM members WHERE id = ?', [id]);
    const payments = await sqliteDb.all(
      'SELECT id, amount, date FROM payments WHERE memberId = ? ORDER BY date DESC',
      [id]
    );
    return res.json({ ...updated, payments: payments || [] });
  }

  res.status(500).json({ error: 'Database not initialized' });
}));

app.post('/api/members/:id/payments', asyncHandler(async (req: any, res: any) => {
  await dbReady;
  const { id: memberId } = req.params;
  const { amount, date } = req.body;

  if (isFirebase && membersRef) {
    const paymentsRef = membersRef.child(memberId).child('payments');
    const newPaymentRef = paymentsRef.push();
    await newPaymentRef.set({
      amount: Number(amount),
      date
    });

    return res.json({ id: newPaymentRef.key, amount, date });
  }

  if (sqliteDb) {
    const pid = crypto.randomUUID();
    await sqliteDb.run(
      'INSERT INTO payments (id, memberId, amount, date) VALUES (?, ?, ?, ?)',
      [pid, memberId, Number(amount), date]
    );
    return res.json({ id: pid, amount: Number(amount), date });
  }

  res.status(500).json({ error: 'Database not initialized' });
}));

app.delete('/api/payments/:id', asyncHandler(async (req: any, res: any) => {
  await dbReady;
  const { id } = req.params;
  const memberId = req.query.memberId as string;
  
  if (!id || !memberId) {
    return res.status(400).send('Missing id or memberId');
  }

  if (isFirebase && membersRef) {
    await membersRef.child(memberId).child('payments').child(id).remove();
    return res.sendStatus(204);
  }

  if (sqliteDb) {
    await sqliteDb.run('DELETE FROM payments WHERE id = ? AND memberId = ?', [id, memberId]);
    return res.sendStatus(204);
  }

  res.sendStatus(204);
}));

// Thêm thành viên mới
app.post('/api/members', asyncHandler(async (req: any, res: any) => {
  await dbReady;
  const { name, startDate } = req.body;
  const memberName = name || 'Thành viên mới';
  const memberStartDate = startDate || new Date().toISOString().split('T')[0];

  if (isFirebase && membersRef) {
    const newRef = membersRef.push();
    await newRef.set({
      name: memberName,
      startDate: memberStartDate,
      initialBalance: 0
    });
    return res.json({ id: newRef.key, name: memberName, startDate: memberStartDate, initialBalance: 0, payments: [] });
  }

  if (sqliteDb) {
    const mid = crypto.randomUUID();
    await sqliteDb.run(
      'INSERT INTO members (id, name, startDate, initialBalance) VALUES (?, ?, ?, 0)',
      [mid, memberName, memberStartDate]
    );
    return res.json({ id: mid, name: memberName, startDate: memberStartDate, initialBalance: 0, payments: [] });
  }

  res.status(500).json({ error: 'Database not initialized' });
}));

// Xóa thành viên
app.delete('/api/members/:id', asyncHandler(async (req: any, res: any) => {
  await dbReady;
  const { id } = req.params;

  if (isFirebase && membersRef) {
    await membersRef.child(id).remove();
    return res.sendStatus(204);
  }

  if (sqliteDb) {
    await sqliteDb.run('DELETE FROM members WHERE id = ?', [id]);
    await sqliteDb.run('DELETE FROM payments WHERE memberId = ?', [id]);
    return res.sendStatus(204);
  }

  res.sendStatus(204);
}));

if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Backend server listening at http://localhost:${port}`);
  });
}

export default app;
