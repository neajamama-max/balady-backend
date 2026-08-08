// ============================================================
// بلدي — Backend حقيقي
// Node.js + Express + SQLite + bcrypt + JWT
// ============================================================
// يطابق موقع "بلدي" الحالي: فييد منشورات (بصور متعددة)، موافقة
// مسبقة من الإدارة، وإعدادات موقع كاملة (بانر، مناطق، مجالات، ألوان).
//
// طريقة التشغيل محلياً:
//   1) npm install
//   2) node create-admin.js editor "كلمة-مرور-قوية"
//   3) node server.js
// ============================================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// !!! غيّر هاد السر قبل النشر، وحطه بمتغير بيئة (Environment Variable) مش بالكود !!!
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_BEFORE_DEPLOY';

// ---------- إعداد قاعدة البيانات ----------
const db = new Database(path.join(__dirname, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    town TEXT NOT NULL,
    sector TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    delete_token TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | hidden
    posted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS post_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
  );

  -- صف واحد بس (id=1) بيخزن كل إعدادات الموقع كـ JSON
  -- (اسم الموقع، الوصف، الشريط العاجل، المناطق والمدن، المجالات، لون الخلفية، إعدادات البانر)
  CREATE TABLE IF NOT EXISTS site_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  );
`);

// ترقية آمنة لقاعدة بيانات موجودة من قبل (لو الأعمدة الجديدة مش موجودة، ضيفها بدون ما تمسح البيانات)
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some(c => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`تمت إضافة العمود ${column} لجدول ${table}`);
  }
}
addColumnIfMissing('posts', 'email', 'TEXT');
addColumnIfMissing('posts', 'delete_token', 'TEXT');

// إعدادات افتراضية أول ما تشتغل قاعدة البيانات لأول مرة
const DEFAULT_CONFIG = {
  siteName: 'بلدي',
  tagline: 'بدور عمال؟ بدك شغل؟ هون بتلاقوا بعض',
  ticker: [],
  colors: {
    bg: '#14120F', surface: '#1E1B17', surface2: '#262119', line: '#3A332A',
    ink: '#F2ECE0', inkDim: '#B7AE9C', rust: '#C1502E', rustBright: '#DE6A44',
    olive: '#8A9A5B', sand: '#D9C68F'
  },
  towns: {
    'الجليل': [
      {ar:'الناصرة', he:'נצרת'}, {ar:'سخنين', he:"סח'נין"}, {ar:'شفاعمرو', he:'שפרעם'},
      {ar:'عرابة', he:'עראבה'}, {ar:'دير الأسد', he:'דיר אל-אסד'}
    ],
    'المثلث': [
      {ar:'الطيبة', he:'טייבה'}, {ar:'الطيرة', he:'טירה'},
      {ar:'باقة الغربية', he:'באקה אל-גרבייה'}, {ar:'كفر قاسم', he:'כפר קאסם'}
    ],
    'الساحل': [{ar:'حيفا', he:'חיפה'}, {ar:'عكا', he:'עכו'}, {ar:'يافا', he:'יפו'}],
    'النقب': [{ar:'رهط', he:'רהט'}, {ar:'اللقية', he:'לקיה'}]
  },
  sectors: [
    {ar:'بناء وتشطيبات', he:'בנייה וגימור'}, {ar:'سباكة وكهرباء', he:'אינסטלציה וחשמל'},
    {ar:'دهان وديكور', he:'צביעה ועיצוב'}, {ar:'نقل وتوصيل', he:'הובלות ומשלוחים'},
    {ar:'مطاعم وضيافة', he:'מסעדנות ואירוח'}, {ar:'تنظيف', he:'ניקיון'},
    {ar:'زراعة', he:'חקלאות'}, {ar:'ميكانيكا وصيانة', he:'מכונאות ותחזוקה'},
    {ar:'خياطة ونسيج', he:'תפירה וטקסטיל'}, {ar:'حراسة وأمن', he:'שמירה וביטחון'},
    {ar:'تقنية وحاسوب', he:'טכנולוגיה ומחשבים'}, {ar:'أخرى', he:'אחר'}
  ],
  banner: {
    headingAr: 'لاقي شغلك بأسرع طريق ⚡',
    headingHe: 'תמצא עבודה הכי מהר שיש ⚡',
    subAr: 'بدون سيرة ذاتية، بدون تعقيد — اتصل أو ابعت واتساب وخلص',
    subHe: 'בלי קורות חיים, בלי סיבוכים — פשוט תתקשר או תשלח וואטסאפ וזהו',
    bgColor: '#C1502E',
    textColor: '#12100C',
    size: 'medium'
  }
};

const existingConfig = db.prepare('SELECT data FROM site_config WHERE id = 1').get();
if (!existingConfig) {
  db.prepare('INSERT INTO site_config (id, data) VALUES (1, ?)').run(JSON.stringify(DEFAULT_CONFIG));
}

// ---------- رفع الصور ----------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e6) + '-' + file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 4 }, // 5MB لكل صورة، حتى 4 صور بكل منشور
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('يجب أن يكون الملف صورة'));
    cb(null, true);
  }
});

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadDir));

// ============================================================
// مصادقة الإدارة (Auth)
// ============================================================

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'الرجاء إدخال اسم المستخدم وكلمة المرور' });

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

  const valid = bcrypt.compareSync(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

  const token = jwt.sign({ adminId: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'غير مصرح — الرجاء تسجيل الدخول' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'الجلسة منتهية، الرجاء تسجيل الدخول من جديد' });
  }
}

// ============================================================
// المنشورات — مسارات عامة
// ============================================================

function attachImages(post) {
  const rows = db.prepare('SELECT image_path FROM post_images WHERE post_id = ?').all(post.id);
  return { ...post, images: rows.map(r => r.image_path) };
}

// توليد رمز حذف عشوائي قصير وسهل الكتابة (6 خانات، أحرف كبيرة وأرقام)
function generateDeleteToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بدون أحرف/أرقام متشابهة (0/O, 1/I)
  let token = '';
  for (let i = 0; i < 6; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

// نشر ستاتوس جديد (بيصير status = pending تلقائياً، وبينستنى موافقة الإدارة)
app.post('/api/posts', upload.array('images', 4), (req, res) => {
  const { name, type, content, town, sector, phone, email } = req.body;
  if (!name || !type || !content || !town || !sector || !phone) {
    return res.status(400).json({ error: 'الرجاء تعبئة كل الحقول المطلوبة' });
  }

  const deleteToken = generateDeleteToken();

  const stmt = db.prepare(`
    INSERT INTO posts (name, type, content, town, sector, phone, email, delete_token, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const result = stmt.run(name, type, content, town, sector, phone, email || null, deleteToken);
  const postId = result.lastInsertRowid;

  if (req.files && req.files.length) {
    const insertImg = db.prepare('INSERT INTO post_images (post_id, image_path) VALUES (?, ?)');
    req.files.forEach(file => insertImg.run(postId, `/uploads/${file.filename}`));
  }

  res.status(201).json({
    message: 'تم إرسال الستاتوس، وهو الآن قيد المراجعة',
    id: postId,
    deleteToken // بيرجع مرة وحدة بس هون — احتفظي فيه، بيلزمك لاحقاً تحذفي منشورك بنفسك
  });
});

// حذف منشور من طرف صاحبه (بدون تسجيل دخول إدارة) — لازم يطابق رقم الهاتف ورمز الحذف معاً
app.delete('/api/posts/self', (req, res) => {
  const { phone, deleteToken } = req.body;
  if (!phone || !deleteToken) {
    return res.status(400).json({ error: 'الرجاء إدخال رقم الهاتف ورمز الحذف' });
  }

  const post = db.prepare(`SELECT id FROM posts WHERE phone = ? AND delete_token = ?`).get(phone, deleteToken.toUpperCase());
  if (!post) {
    return res.status(404).json({ error: 'ما لقينا منشور مطابق. تأكدي من رقم الهاتف ورمز الحذف.' });
  }

  const images = db.prepare('SELECT image_path FROM post_images WHERE post_id = ?').all(post.id);
  images.forEach(img => {
    const filePath = path.join(__dirname, img.image_path.replace(/^\//, ''));
    fs.unlink(filePath, () => {});
  });
  db.prepare(`DELETE FROM posts WHERE id = ?`).run(post.id);

  res.json({ message: 'تم حذف المنشور بنجاح' });
});

// الفييد العام — بس المنشورات الموافق عليها (approved)
app.get('/api/posts', (req, res) => {
  const rows = db.prepare(`SELECT * FROM posts WHERE status = 'approved' ORDER BY posted_at DESC`).all();
  res.json(rows.map(attachImages));
});

// إعدادات الموقع العامة (اسم، وصف، شريط عاجل، مناطق، مجالات، ألوان، بانر)
app.get('/api/config', (req, res) => {
  const row = db.prepare('SELECT data FROM site_config WHERE id = 1').get();
  res.json(row ? JSON.parse(row.data) : DEFAULT_CONFIG);
});

// ============================================================
// مسارات الإدارة (محمية بـ requireAdmin)
// ============================================================

// كل المنشورات حسب الحالة: ?status=pending|approved|hidden
app.get('/api/admin/posts', requireAdmin, (req, res) => {
  const status = req.query.status || 'pending';
  const rows = db.prepare(`SELECT * FROM posts WHERE status = ? ORDER BY posted_at DESC`).all(status);
  res.json(rows.map(attachImages));
});

app.post('/api/admin/posts/:id/approve', requireAdmin, (req, res) => {
  const result = db.prepare(`UPDATE posts SET status = 'approved' WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'المنشور غير موجود' });
  res.json({ message: 'تم نشر المنشور بالفييد' });
});

app.post('/api/admin/posts/:id/hide', requireAdmin, (req, res) => {
  const result = db.prepare(`UPDATE posts SET status = 'hidden' WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'المنشور غير موجود' });
  res.json({ message: 'تم إخفاء/رفض المنشور' });
});

app.delete('/api/admin/posts/:id', requireAdmin, (req, res) => {
  // حذف الصور الفعلية من القرص قبل حذف السجل
  const images = db.prepare('SELECT image_path FROM post_images WHERE post_id = ?').all(req.params.id);
  images.forEach(img => {
    const filePath = path.join(__dirname, img.image_path.replace(/^\//, ''));
    fs.unlink(filePath, () => {});
  });
  const result = db.prepare(`DELETE FROM posts WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'المنشور غير موجود' });
  res.json({ message: 'تم حذف المنشور نهائياً' });
});

// جلب إعدادات الموقع (نفس /api/config، بس عبر مسار الإدارة للتناسق)
app.get('/api/admin/config', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT data FROM site_config WHERE id = 1').get();
  res.json(row ? JSON.parse(row.data) : DEFAULT_CONFIG);
});

// تحديث إعدادات الموقع بالكامل — الجسم (body) لازم يكون كائن الإعدادات كامل
// (اسم الموقع، الوصف، الشريط العاجل، المناطق، المجالات، لون الخلفية، البانر)
app.put('/api/admin/config', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT data FROM site_config WHERE id = 1').get();
  const currentData = current ? JSON.parse(current.data) : DEFAULT_CONFIG;
  const updated = { ...currentData, ...req.body };
  db.prepare('UPDATE site_config SET data = ? WHERE id = 1').run(JSON.stringify(updated));
  res.json({ message: 'تم حفظ الإعدادات', config: updated });
});

app.listen(PORT, () => {
  console.log(`بلدي backend شغال على http://localhost:${PORT}`);
});
