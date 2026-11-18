/**
 * 作业批改台 — 服务端
 * 零依赖 Node.js 服务：静态托管 + 账号体系 + AI 批改代理
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ENV_KEY = process.env.AGNES_API_KEY || '';
const DEFAULT_KEY = 'sk-pmZu7oXbpDTjqPe7v7MyvPITP3yQ5AKSnoXL0qyK8kUKFFWH';
const DEFAULT_API_BASE = process.env.AGNES_BASE || 'https://apihub.agnes-ai.com/v1';
const DEFAULT_MODEL = process.env.AGNES_MODEL || 'agnes-2.5-flash';
const MODEL_PRESETS = [
  'agnes-2.5-flash',
  'agnes-2.5-pro',
  'agnes-3.0-flash',
  'agnes-2.5-pro-alpha',
  'gpt-4o-mini',
  'gpt-4o',
  'deepseek-chat',
  'moonshot-v1-8k',
  'qwen-vl-max',
];

/** 接口地址：前端可自定义，非法则回退默认 */
function normalizeBase(b) {
  const s = String(b || '').trim();
  if (!s) return DEFAULT_API_BASE;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return DEFAULT_API_BASE;
    return s.replace(/\/+$/, '');
  } catch (e) {
    return DEFAULT_API_BASE;
  }
}

/* ================= 账号与会话 ================= */
/** 是否需要登录：默认关闭（直接进入）。设 REQUIRE_LOGIN=1 可重新开启账号体系。 */
const AUTH_ON = process.env.REQUIRE_LOGIN === '1';
const GUEST = { username: '', role: 'admin', guest: true };
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret');
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'Aa111211';
const SESSION_DAYS = 30;

let users = [];
let secret = '';

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadSecret() {
  try {
    secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch (e) {
    secret = '';
  }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    try {
      ensureDataDir();
      fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    } catch (e) {}
  }
}
function hashPwd(pwd, salt) {
  return crypto.scryptSync(String(pwd), salt, 64).toString('hex');
}
function makeUser(name, pwd, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { u: name, salt, hash: hashPwd(pwd, salt), role, createdAt: Date.now() };
}
function checkPwd(user, pwd) {
  try {
    const a = Buffer.from(user.hash, 'hex');
    const b = Buffer.from(hashPwd(pwd, user.salt), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}
function saveUsers() {
  try {
    ensureDataDir();
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('保存用户失败:', e.message);
  }
}
function loadUsers() {
  try {
    const j = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    users = Array.isArray(j.users) ? j.users : [];
  } catch (e) {
    users = [];
  }
  if (!users.length) {
    users = [makeUser(ADMIN_USER, ADMIN_PASS, 'admin')];
    saveUsers();
    console.log(`已创建管理员账号：${ADMIN_USER} / ${ADMIN_PASS}`);
  }
}
function findUser(name) {
  const n = String(name || '').trim();
  return users.find((x) => x.u.toLowerCase() === n.toLowerCase());
}

/* --- 会话：签名 Cookie，无服务端会话表 --- */
function signToken(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(b).digest('base64url');
  return b + '.' + mac;
}
function readToken(t) {
  if (!t || typeof t !== 'string') return null;
  const idx = t.lastIndexOf('.');
  if (idx < 1) return null;
  const b = t.slice(0, idx);
  const mac = t.slice(idx + 1);
  const expect = crypto.createHmac('sha256', secret).update(b).digest('base64url');
  const a = Buffer.from(mac);
  const c = Buffer.from(expect);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (!p || !p.u || !p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) {
    return null;
  }
}
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function sessionOf(req) {
  const p = readToken(parseCookies(req).hw_session);
  if (!p) return null;
  const u = findUser(p.u);
  if (!u) return null;
  return { username: u.u, role: u.role };
}
function setSessionCookie(req, res, username) {
  const exp = Date.now() + SESSION_DAYS * 86400e3;
  const token = signToken({ u: username, exp });
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `hw_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'hw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/* --- 登录失败限流 --- */
const loginFails = new Map();
function tooManyFails(ip) {
  const now = Date.now();
  const arr = (loginFails.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  loginFails.set(ip, arr);
  return arr.length >= 10;
}
function noteFail(ip) {
  const arr = loginFails.get(ip) || [];
  arr.push(Date.now());
  loginFails.set(ip, arr);
}
function clearFails(ip) {
  loginFails.delete(ip);
}

/* ---------------- 密钥 ----------------
 * 主存储在前端（浏览器 localStorage），每次批改随请求带上；
 * 服务端只保留一个可选的兜底密钥（环境变量或内置），供没填密钥的人使用。
 */
/** 服务端兜底密钥：环境变量优先 */
function fallbackKey() {
  return ENV_KEY || DEFAULT_KEY;
}
function fallbackSource() {
  if (ENV_KEY) return 'env';
  if (DEFAULT_KEY) return 'builtin';
  return 'none';
}
/** 本次请求实际使用的密钥：请求里带的优先，否则用服务端兜底 */
function resolveKey(reqKey) {
  const k = String(reqKey || '').trim();
  if (looksLikeKey(k)) return k;
  return fallbackKey();
}
function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  if (s.length <= 8) return '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}
function looksLikeKey(k) {
  return /^sk-[A-Za-z0-9_\-]{8,}$/.test(String(k || '').trim());
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------- 简易限流 ---------------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = 60 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 300;
}

/* ---------------- 工具 ---------------- */
function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('图片太大，请压缩后重试'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 从模型输出中尽力抽取 JSON 对象 */
function extractJSON(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (e) {
          try {
            return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
          } catch (e2) {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '对', '正确', '是', 'yes', 'y', '1'].includes(s)) return true;
    if (['false', '错', '错误', '否', 'no', 'n', '0'].includes(s)) return false;
  }
  return null;
}

/** 规范化模型返回，保证前端拿到的结构稳定 */
function normalize(raw, ctx) {
  const out = {
    title: (raw && (raw.title || raw.name)) || '作业',
    subject: (raw && raw.subject) || ctx.subject || '',
    score: null,
    fullScore: ctx.fullScore,
    questions: [],
    summary: (raw && (raw.summary || raw.comment || raw.overall)) || '',
    strengths: [],
    weaknesses: [],
    suggestions: [],
    teacherNote: '',
  };

  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== '') : v ? [v] : []);
  out.strengths = arr(raw && (raw.strengths || raw.优点)).map(String).slice(0, 6);
  out.weaknesses = arr(raw && (raw.weaknesses || raw.不足 || raw.weakness)).map(String).slice(0, 6);
  out.suggestions = arr(raw && (raw.suggestions || raw.建议 || raw.advice)).map(String).slice(0, 6);

  let qs = (raw && (raw.questions || raw.items || raw.题目)) || [];
  if (!Array.isArray(qs)) qs = [];
  out.questions = qs.slice(0, 80).map((q, i) => {
    if (typeof q !== 'object' || q === null) {
      return {
        no: String(i + 1),
        studentAnswer: String(q ?? ''),
        correctAnswer: '',
        isCorrect: null,
        knowledgePoint: '',
        comment: '',
      };
    }
    return {
      no: String(q.no ?? q.number ?? q.index ?? i + 1),
      type: String(q.type || q.题型 || ''),
      studentAnswer: String(q.studentAnswer ?? q.student_answer ?? q.answer ?? q.学生答案 ?? '').trim(),
      correctAnswer: String(q.correctAnswer ?? q.correct_answer ?? q.correct ?? q.正确答案 ?? '').trim(),
      isCorrect: toBool(q.isCorrect ?? q.correct ?? q.正确),
      knowledgePoint: String(q.knowledgePoint ?? q.knowledge ?? q.point ?? q.知识点 ?? '').trim(),
      comment: String(q.comment ?? q.点评 ?? q.note ?? '').trim(),
    };
  });

  const total = out.questions.length;
  const right = out.questions.filter((q) => q.isCorrect === true).length;
  const wrong = out.questions.filter((q) => q.isCorrect === false).length;
  out.totalQuestions = total;
  out.correctCount = right;
  out.wrongCount = wrong;
  out.accuracy = total ? Math.round((right / total) * 1000) / 10 : 0;

  const s = Number(raw && (raw.score ?? raw.得分 ?? raw.totalScore));
  if (Number.isFinite(s) && s >= 0) {
    out.score = Math.round(Math.min(s, ctx.fullScore) * 10) / 10;
  } else {
    out.score = total ? Math.round((right / total) * ctx.fullScore * 10) / 10 : 0;
  }
  // 分数与正确率严重不符时以正确率为准（容忍 20% 满分的主观浮动）
  if (total) {
    const expected = (right / total) * ctx.fullScore;
    if (Math.abs(out.score - expected) > ctx.fullScore * 0.2) {
      out.score = Math.round(expected * 10) / 10;
    }
  }
  return out;
}

/* ---------------- 提示词 ---------------- */
function buildPrompt({ subject, fullScore, extraPrompt, studentName }) {
  const sys = [
    `你是一位经验丰富的${subject || '学科'}老师，正在批改学生提交的作业照片。`,
    '要求：',
    '1. 仔细识别图片中的每一道题：题号、学生作答内容（含手写笔迹）。',
    '2. 逐题判断对错，给出正确答案、对应知识点与简短点评。',
    '3. 若某题字迹无法辨认，isCorrect 填 null，并在 comment 中说明。',
    '4. 只输出一个 JSON 对象，不要使用 markdown 代码块，不要输出任何解释性文字。',
    '5. 所有文字使用简体中文。',
    '6. 若题目带图形（几何图、函数图像、统计图、电路图等），必须先读懂图中的标注——顶点字母、边长、角度、直角符号、平行/垂直标记、虚线与辅助线——再据此判断，不要凭空假设图形条件。',
    '7. 几何证明题不能只看结论：要检查每一步的依据是否成立、条件是否给足、有没有循环论证（把待证结论当成已知用），判定错误时在 comment 中指出具体哪一步不成立。',
    '8. 计算题若学生只写答案，按答案对错判定；若写了过程且过程有错但答案巧合正确，判为错误并说明原因。',
  ].join('\n');

  const user = [
    `请批改这份${subject || ''}作业${studentName ? `（学生：${studentName}）` : ''}，满分 ${fullScore} 分。`,
    extraPrompt ? `老师补充要求：${extraPrompt}` : '',
    '输出 JSON，结构如下：',
    '{',
    '  "title": "作业标题（如「分数乘法练习」，无法判断则填 作业）",',
    `  "score": 得分数字（0-${fullScore}，与答对比例基本一致）,`,
    '  "summary": "两三句总评，说明整体表现与最突出的问题",',
    '  "questions": [',
    '    {"no":"1","studentAnswer":"学生写的答案","correctAnswer":"正确答案","isCorrect":true,"knowledgePoint":"知识点","comment":"简短点评，答对可留空"}',
    '  ],',
    '  "strengths": ["做得好的地方"],',
    '  "weaknesses": ["薄弱环节"],',
    '  "suggestions": ["给学生的具体改进建议"]',
    '}',
    '注意：questions 必须逐题列出图片中全部题目（常见 3~20 道），按题号排序；漏题视为严重错误，也不要虚构不存在的题。',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: sys },
    {
      role: 'user',
      content: [
        { type: 'text', text: user },
        { type: 'image_url', image_url: { url: '__IMAGE__' } },
      ],
    },
  ];
}

async function callModel(messages, model, imageUrl, key, apiBase) {
  const body = {
    model,
    messages: messages.map((m) =>
      Array.isArray(m.content)
        ? {
            role: m.role,
            content: m.content.map((p) =>
              p.type === 'image_url' ? { type: 'image_url', image_url: { url: imageUrl } } : p
            ),
          }
        : m
    ),
    temperature: 0.1,
    max_tokens: 4096,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000);
  try {
    const r = await fetch(`${normalizeBase(apiBase)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key || fallbackKey()}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 400);
      try {
        msg = JSON.parse(text).error?.message || msg;
      } catch (e) {}
      throw new Error(`AI 接口错误 (${r.status})：${msg}`);
    }
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content || '';
    return content;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI 接口响应超时，请稍后重试');
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo|network/i.test(e.message || '')) {
      throw new Error('无法连接 AI 接口，请检查「设置」里的接口地址和网络');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 路由 ---------------- */
/** 用一次最小对话请求校验密钥是否可用（/models 对无效密钥不一定报错，实测不可靠） */
async function verifyKey(key, apiBase, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${normalizeBase(apiBase)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: ctrl.signal,
    });
    if (r.ok) return { ok: true };
    let msg = '';
    try {
      const j = await r.json();
      msg = j.error?.message || '';
    } catch (e) {}
    if (/invalid token|invalid api key|unauthorized|incorrect api key/i.test(msg)) {
      return { ok: false, error: '密钥无效或已失效' };
    }
    if (/model/i.test(msg) && /not|invalid|exist|unsupported/i.test(msg)) {
      return { ok: false, error: '这个接口地址下没有该模型：' + msg.slice(0, 80) };
    }
    return { ok: false, error: msg ? msg.slice(0, 160) : `接口返回 ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '连接 AI 接口超时' : '无法连接该接口地址，请检查网络或地址' };
  } finally {
    clearTimeout(timer);
  }
}

/** 只校验密钥/地址是否可用，不保存（由前端自己存） */
async function handleVerify(req, res) {
  if (!requireAuth(req, res)) return;
  let payload;
  try {
    payload = JSON.parse(await readBody(req, 64 * 1024));
  } catch (e) {
    return json(res, 400, { ok: false, error: '请求体解析失败' });
  }
  const key = String((payload && payload.key) || '').trim();
  const apiBase = String((payload && payload.apiBase) || '').trim();
  const model = String((payload && payload.model) || '').trim();
  if (!looksLikeKey(key)) {
    return json(res, 400, { ok: false, error: '密钥格式不对，应以 sk- 开头' });
  }
  if (apiBase) {
    try {
      const u = new URL(apiBase);
      if (!/^https?:$/.test(u.protocol)) throw new Error('bad');
    } catch (e) {
      return json(res, 400, { ok: false, error: '接口地址格式不对，应形如 https://api.xxx.com/v1' });
    }
  }
  const check = await verifyKey(key, apiBase, model);
  if (!check.ok) return json(res, 400, { ok: false, error: check.error || '校验失败' });
  return json(res, 200, { ok: true, masked: maskKey(key), apiBase: normalizeBase(apiBase), model: model || DEFAULT_MODEL });
}

/* ---------------- 账号路由 ---------------- */
const NAME_RE = /^[\w\u4e00-\u9fa5.\-]{2,20}$/;

async function handleRegister(req, res) {
  let p;
  try {
    p = JSON.parse(await readBody(req, 64 * 1024));
  } catch (e) {
    return json(res, 400, { ok: false, error: '请求体解析失败' });
  }
  const name = String((p && p.username) || '').trim();
  const pwd = String((p && p.password) || '');
  if (!NAME_RE.test(name)) return json(res, 400, { ok: false, error: '用户名 2-20 位，可用中英文、数字、下划线' });
  if (pwd.length < 6) return json(res, 400, { ok: false, error: '密码至少 6 位' });
  if (findUser(name)) return json(res, 400, { ok: false, error: '这个用户名已被占用' });
  const u = makeUser(name, pwd, 'user');
  users.push(u);
  saveUsers();
  setSessionCookie(req, res, u.u);
  return json(res, 200, { ok: true, user: { username: u.u, role: u.role } });
}

async function handleLogin(req, res, ip) {
  if (tooManyFails(ip)) return json(res, 429, { ok: false, error: '密码错误次数过多，请 10 分钟后再试' });
  let p;
  try {
    p = JSON.parse(await readBody(req, 64 * 1024));
  } catch (e) {
    return json(res, 400, { ok: false, error: '请求体解析失败' });
  }
  const name = String((p && p.username) || '').trim();
  const pwd = String((p && p.password) || '');
  const u = findUser(name);
  if (!u || !checkPwd(u, pwd)) {
    noteFail(ip);
    return json(res, 401, { ok: false, error: '用户名或密码不对' });
  }
  clearFails(ip);
  setSessionCookie(req, res, u.u);
  return json(res, 200, { ok: true, user: { username: u.u, role: u.role } });
}

function handleLogout(req, res) {
  clearSessionCookie(res);
  return json(res, 200, { ok: true });
}

function requireAuth(req, res) {
  if (!AUTH_ON) return GUEST;
  const s = sessionOf(req);
  if (!s) {
    json(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '请先登录' });
    return null;
  }
  return s;
}

function requireAdmin(req, res) {
  const s = requireAuth(req, res);
  if (!s) return null;
  if (s.role !== 'admin') {
    json(res, 403, { ok: false, error: '只有管理员可以操作' });
    return null;
  }
  return s;
}

function handleUsersList(req, res) {
  const s = requireAdmin(req, res);
  if (!s) return;
  return json(res, 200, {
    ok: true,
    users: users.map((u) => ({ username: u.u, role: u.role, createdAt: u.createdAt })),
  });
}

async function handleUserDelete(req, res) {
  const s = requireAdmin(req, res);
  if (!s) return;
  let p;
  try {
    p = JSON.parse(await readBody(req, 64 * 1024));
  } catch (e) {
    return json(res, 400, { ok: false, error: '请求体解析失败' });
  }
  const name = String((p && p.username) || '').trim();
  const target = findUser(name);
  if (!target) return json(res, 404, { ok: false, error: '没有这个用户' });
  if (target.role === 'admin') return json(res, 400, { ok: false, error: '不能删除管理员账号' });
  if (target.u === s.username) return json(res, 400, { ok: false, error: '不能删除自己' });
  users = users.filter((u) => u.u !== target.u);
  saveUsers();
  return json(res, 200, { ok: true });
}

async function handlePassword(req, res) {
  const s = requireAuth(req, res);
  if (!s) return;
  let p;
  try {
    p = JSON.parse(await readBody(req, 64 * 1024));
  } catch (e) {
    return json(res, 400, { ok: false, error: '请求体解析失败' });
  }
  const oldPwd = String((p && p.oldPassword) || '');
  const newPwd = String((p && p.newPassword) || '');
  if (newPwd.length < 6) return json(res, 400, { ok: false, error: '新密码至少 6 位' });
  const u = findUser(s.username);
  if (!u) return json(res, 404, { ok: false, error: '账号不存在' });
  if (!checkPwd(u, oldPwd)) return json(res, 400, { ok: false, error: '原密码不对' });
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = hashPwd(newPwd, u.salt);
  saveUsers();
  return json(res, 200, { ok: true });
}

async function handleGrade(req, res, ip) {
  if (rateLimited(ip)) return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
  const sess = requireAuth(req, res);
  if (!sess) return;

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, { ok: false, error: e.message || '请求体解析失败' });
  }

  const { image, subject, fullScore, extraPrompt, studentName } = payload || {};
  if (!image || !/^data:image\//.test(image)) {
    return json(res, 400, { ok: false, error: '缺少有效的图片数据' });
  }
  const fs2 = Math.max(1, Math.min(300, Number(fullScore) || 100));
  const model = String((payload && payload.model) || '').trim().slice(0, 80) || DEFAULT_MODEL;
  const apiBase = normalizeBase(payload && payload.apiBase);
  const ctx = { subject: String(subject || '').slice(0, 20), fullScore: fs2 };
  const key = resolveKey(payload.apiKey);
  if (!looksLikeKey(key)) {
    return json(res, 400, { ok: false, error: '还没有配置 API 密钥，请先到「设置」页填写' });
  }

  const messages = buildPrompt({
    subject: ctx.subject,
    fullScore: fs2,
    extraPrompt: String(extraPrompt || '').slice(0, 600),
    studentName: String(studentName || '').slice(0, 30),
  });

  try {
    let content = await callModel(messages, model, image, key, apiBase);
    let parsed = extractJSON(content);
    if (!parsed) {
      // 一次修复尝试
      content = await callModel(
        [
          ...messages,
          { role: 'assistant', content: String(content).slice(0, 2000) },
          {
            role: 'user',
            content: '上面的输出不是合法 JSON。请只重新输出修正后的 JSON 对象，不要任何多余文字。',
          },
        ],
        model,
        image,
        key,
        apiBase
      );
      parsed = extractJSON(content);
    }
    if (!parsed) {
      return json(res, 502, { ok: false, error: 'AI 返回内容无法解析为结构化结果，请重试' });
    }
    const data = normalize(parsed, ctx);
    if (!data.questions.length) {
      return json(res, 502, { ok: false, error: '未能从图片中识别出题目，请换一张更清晰的照片' });
    }
    data.model = model;
    return json(res, 200, { ok: true, data });
  } catch (e) {
    return json(res, 502, { ok: false, error: e.message || '批改失败' });
  }
}

function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    const isHTML = ext === '.html';
    const noCache = ['.html', '.css', '.js', '.webmanifest'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  if (url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      fallbackConfigured: looksLikeKey(fallbackKey()),
      fallbackMasked: maskKey(fallbackKey()),
      fallbackSource: fallbackSource(),
      defaultModel: DEFAULT_MODEL,
      models: MODEL_PRESETS,
      apiBase: DEFAULT_API_BASE,
      authEnabled: AUTH_ON,
    });
  }
  if (url.pathname === '/api/verify' && req.method === 'POST') {
    return handleVerify(req, res);
  }
  if (url.pathname === '/api/register' && req.method === 'POST') {
    return handleRegister(req, res);
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    return handleLogin(req, res, ip);
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    return handleLogout(req, res);
  }
  if (url.pathname === '/api/me' && req.method === 'GET') {
    if (!AUTH_ON) return json(res, 200, { ok: true, user: GUEST, authEnabled: false });
    const s = sessionOf(req);
    if (!s) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '未登录' });
    return json(res, 200, { ok: true, user: s, authEnabled: true });
  }
  if (url.pathname === '/api/users' && req.method === 'GET') {
    return handleUsersList(req, res);
  }
  if (url.pathname === '/api/users/delete' && req.method === 'POST') {
    return handleUserDelete(req, res);
  }
  if (url.pathname === '/api/password' && req.method === 'POST') {
    return handlePassword(req, res);
  }
  if (url.pathname === '/api/grade' && req.method === 'POST') {
    return handleGrade(req, res, ip);
  }
  if (url.pathname.startsWith('/api/')) {
    return json(res, 404, { ok: false, error: 'Not Found' });
  }
  return serveStatic(req, res, url.pathname);
});

loadSecret();
loadUsers();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`作业批改台已启动: http://localhost:${PORT}`);
  console.log(`账号：${users.length} 个（管理员 ${ADMIN_USER}）`);
});
