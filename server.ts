import express from 'express';
import cors from 'cors';
import asyncHandler from 'express-async-handler';
import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

const app = express();
const port = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'netflop-secret-key-2026-auth-secure';

export function createToken(payload: { username: string; name?: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
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

// Initialize Firebase Admin
try {
  const serviceAccountJson = process.env.FIREBASE_PRIVATE_KEY_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FB_SERVICE_ACCOUNT;
  
  if (serviceAccountJson) {
    // Cách 1: Copy toàn bộ nội dung file JSON vào 1 biến môi trường (FIREBASE_PRIVATE_KEY_JSON)
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://unichat-acfc2-default-rtdb.firebaseio.com"
    });
    console.log("Firebase initialized via Single JSON ENV");
  } else if (process.env.FB_PRIVATE_KEY) {
    // Cách 2: Tách thành 3 biến riêng lẻ (FB_PROJECT_ID, FB_CLIENT_EMAIL, FB_PRIVATE_KEY)
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
    // Cách 3: Chạy ở Local bằng file JSON trực tiếp
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

const db = admin.apps.length > 0 ? admin.database() : null;
const membersRef = db ? db.ref('members') : null;

// ================= AUTH ROUTES =================

app.post(['/api/auth/login', '/api/login'], (req: any, res: any) => {
  const { username, password } = req.body || {};
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '').trim();

  if (cleanUser === 'lichdt' && cleanPass === '389363') {
    const token = createToken({ username: 'lichdt', name: 'lichdt' });
    return res.json({
      success: true,
      token,
      user: {
        username: 'lichdt',
        name: 'lichdt'
      }
    });
  }

  return res.status(401).json({
    success: false,
    message: 'Sai tên đăng nhập hoặc mật khẩu!'
  });
});

app.get('/api/auth/me', (req: any, res: any) => {
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
});

app.post(['/api/auth/logout', '/api/logout'], (req: any, res: any) => {
  res.json({ success: true, message: 'Đăng xuất thành công' });
});

// ================= MEMBER & PAYMENT ROUTES =================

app.get('/api/members', asyncHandler(async (req: any, res: any) => {
  if (!membersRef) {
    return res.json([]);
  }
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

  res.json(members);
}));

app.put('/api/members/:id', asyncHandler(async (req: any, res: any) => {
  if (!membersRef) return res.status(500).json({ error: 'Database not initialized' });
  const { id } = req.params;
  const { name, initialBalance, startDate } = req.body;

  const memberRef = membersRef.child(id);
  await memberRef.update({
    name,
    initialBalance: Number(initialBalance),
    startDate
  });

  const updated = (await memberRef.once('value')).val();
  res.json({ ...updated, id });
}));

app.post('/api/members/:id/payments', asyncHandler(async (req: any, res: any) => {
  if (!membersRef) return res.status(500).json({ error: 'Database not initialized' });
  const { id: memberId } = req.params;
  const { amount, date } = req.body;

  const paymentsRef = membersRef.child(memberId).child('payments');
  const newPaymentRef = paymentsRef.push();
  await newPaymentRef.set({
    amount: Number(amount),
    date
  });

  res.json({ id: newPaymentRef.key, amount, date });
}));

app.delete('/api/payments/:id', asyncHandler(async (req: any, res: any) => {
  if (!membersRef) return res.status(500).json({ error: 'Database not initialized' });
  const { id } = req.params;
  const memberId = req.query.memberId as string;
  
  if (!id || !memberId) {
    return res.status(400).send('Missing id or memberId');
  }

  await membersRef.child(memberId).child('payments').child(id).remove();
  res.sendStatus(204);
}));

// Thêm thành viên mới
app.post('/api/members', asyncHandler(async (req: any, res: any) => {
  if (!membersRef) return res.status(500).json({ error: 'Database not initialized' });
  const { name, startDate } = req.body;
  const newRef = membersRef.push();
  await newRef.set({
    name: name || 'Thành viên mới',
    startDate: startDate || new Date().toISOString().split('T')[0],
    initialBalance: 0
  });
  res.json({ id: newRef.key, name, startDate, initialBalance: 0, payments: [] });
}));

// Xóa thành viên
app.delete('/api/members/:id', asyncHandler(async (req: any, res: any) => {
  if (!membersRef) return res.status(500).json({ error: 'Database not initialized' });
  const { id } = req.params;
  await membersRef.child(id).remove();
  res.sendStatus(204);
}));

if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Backend server listening at http://localhost:${port}`);
  });
}

export default app;
