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
const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', 1); // ضروري حتى req.ip يعطي IP الزائر الحقيقي (Render خلف بروكسي)
const PORT = process.env.PORT || 3000;

// !!! غيّر هاد السر قبل النشر، وحطه بمتغير بيئة (Environment Variable) مش بالكود !!!
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_BEFORE_DEPLOY';

// ---------- إعداد قاعدة البيانات ----------
// مجلد تخزين البيانات — لازم يكون مسار "القرص الدائم" (Persistent Disk) بعد ربطه على Render،
// وإلا رح تنمسح البيانات (قاعدة البيانات + الصور) مع أي تحديث أو إعادة تشغيل للسيرفر!
const DATA_DIR = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(DATA_DIR, 'data.db'));
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

  -- رسائل صفحة "اتصل بنا" — بتتخزن هون كنسخة احتياطية حتى لو الإيميل ما وصل
  CREATE TABLE IF NOT EXISTS contact_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- تبليغات عن منشورات (مثلاً: نشر بيانات شخص تاني بدون إذنه) — بتحفظ نسخة من المنشور وقت التبليغ
  -- حتى لو انحذف المنشور بعدين، الإدارة تضل تقدر تراجع التبليغ
  CREATE TABLE IF NOT EXISTS post_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    post_snapshot TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  tickerBgColor: '#C1502E',
  tickerTextColor: '#FFFFFF',
  colors: {
    bg: '#F0F2F5', surface: '#FFFFFF', surface2: '#E9EBEE', line: '#DADDE1',
    ink: '#1C1E21', inkDim: '#65676B', rust: '#C1502E', rustBright: '#DE6A44',
    olive: '#3C9D5B', sand: '#B26B00'
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
const uploadDir = path.join(DATA_DIR, 'uploads');
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

// رفع أكبر مخصص لصورة البانر (صورة واحدة كبيرة، مش أربع صور صغار)
const bannerUpload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB — كافية لصور مصممة عالية الجودة
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('يجب أن يكون الملف صورة'));
    cb(null, true);
  }
});

// يلتقط أي خطأ من Multer (حجم كبير، نوع ملف غلط...) ويرجعه برسالة JSON واضحة بدل ما يفشل بصمت
function handleUploadErrors(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'حجم الصورة كبير أكتر من المسموح. قلّلي حجمها وحاولي مرة ثانية.' });
    }
    return res.status(400).json({ error: 'صار خطأ برفع الملف: ' + err.message });
  } else if (err) {
    return res.status(400).json({ error: err.message || 'صار خطأ برفع الملف' });
  }
  next();
}

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(uploadDir));

// ============================================================
// حماية من السبام: حد أقصى للطلبات لكل IP + حقل "فخ" (Honeypot)
// ============================================================

// خزّان بسيط بالذاكرة يتتبع عدد الطلبات لكل IP بفترة زمنية معيّنة
const rateLimitStore = new Map();

function rateLimit(maxRequests, windowMinutes) {
  const windowMs = windowMinutes * 60 * 1000;
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const key = `${req.path}:${ip}`;
    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (!entry || now - entry.start > windowMs) {
      rateLimitStore.set(key, { count: 1, start: now });
      return next();
    }
    if (entry.count >= maxRequests) {
      return res.status(429).json({ error: 'في محاولات كتير بوقت قصير. الرجاء الانتظار شوي والمحاولة مرة ثانية.' });
    }
    entry.count++;
    next();
  };
}

// تنظيف دوري للخزّان حتى ما يكبر بلا داعي (كل ساعة)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now - entry.start > 60 * 60 * 1000) rateLimitStore.delete(key);
  }
}, 60 * 60 * 1000);

// حقل "فخ" مخفي بالفورم — إنسان حقيقي ما بيعبيه، بس بوتات التعبئة التلقائية غالباً بتعبيه.
// إذا انعبى، منرجع نجاح وهمي (حتى ما يعرف البوت إنه انكشف) بدون ما نخزّن أي شي فعلياً.
function checkHoneypot(req, res, next) {
  const honeypotValue = req.body && req.body.website;
  if (honeypotValue && honeypotValue.trim() !== '') {
    return res.status(201).json({ message: 'تم بنجاح' }); // نجاح وهمي، ما بنخزن إشي
  }
  next();
}

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
app.post('/api/posts', rateLimit(5, 10), upload.array('images', 4), handleUploadErrors, checkHoneypot, (req, res) => {
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
app.delete('/api/posts/self', rateLimit(10, 10), (req, res) => {
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
    const filePath = path.join(DATA_DIR, img.image_path.replace(/^\//, ''));
    fs.unlink(filePath, () => {});
  });
  db.prepare(`DELETE FROM posts WHERE id = ?`).run(post.id);

  res.json({ message: 'تم حذف المنشور بنجاح' });
});

// إبلاغ عن منشور (مثلاً: نشر بيانات شخص تاني بدون إذنه، محتوى مسيء، إلخ) — متاح لأي زائر بدون تسجيل دخول
app.post('/api/posts/:id/report', rateLimit(10, 10), checkHoneypot, (req, res) => {
  const { reason } = req.body;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'المنشور غير موجود' });

  db.prepare('INSERT INTO post_reports (post_id, post_snapshot, reason) VALUES (?, ?, ?)')
    .run(post.id, JSON.stringify(post), reason || null);

  res.status(201).json({ message: 'تم إرسال التبليغ، رح تراجعه الإدارة قريباً' });
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
    const filePath = path.join(DATA_DIR, img.image_path.replace(/^\//, ''));
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

// رفع صورة بانر مخصصة (يصممها المستخدم بنفسه) — بتحل محل بانر النص/التدرج تلقائياً
app.post('/api/admin/banner-image', requireAdmin, bannerUpload.single('image'), handleUploadErrors, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'الرجاء اختيار صورة' });

  const current = db.prepare('SELECT data FROM site_config WHERE id = 1').get();
  const currentData = current ? JSON.parse(current.data) : DEFAULT_CONFIG;
  currentData.banner = currentData.banner || {};
  currentData.banner.image = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE site_config SET data = ? WHERE id = 1').run(JSON.stringify(currentData));

  res.json({ message: 'تم رفع صورة البانر', imageUrl: currentData.banner.image, config: currentData });
});

// إزالة صورة البانر المخصصة (رجوع لبانر النص/التدرج)
app.delete('/api/admin/banner-image', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT data FROM site_config WHERE id = 1').get();
  const currentData = current ? JSON.parse(current.data) : DEFAULT_CONFIG;
  currentData.banner = currentData.banner || {};
  currentData.banner.image = null;
  db.prepare('UPDATE site_config SET data = ? WHERE id = 1').run(JSON.stringify(currentData));
  res.json({ message: 'تمت إزالة صورة البانر', config: currentData });
});

// ============================================================
// نموذج "اتصل بنا" — بيبعت إيميل حقيقي على إيميلك الخاص + بيحفظ نسخة احتياطية
// ============================================================

// إعداد بريد Gmail لإرسال رسائل "اتصل بنا" — لازم تضيفي هالمتغيرات بيئة على Render:
// GMAIL_USER = إيميل Gmail تبعك
// GMAIL_APP_PASSWORD = "App Password" (مش كلمة مرور Gmail العادية — راجعي التعليمات)
// CONTACT_EMAIL = الإيميل يلي بدك الرسائل توصله (ممكن يكون نفس GMAIL_USER)
let mailTransporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
}

app.post('/api/contact', rateLimit(5, 10), checkHoneypot, async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !message) {
    return res.status(400).json({ error: 'الرجاء كتابة الاسم والرسالة' });
  }

  // نحفظ نسخة بقاعدة البيانات دائماً (حتى لو الإيميل ما اشتغل، الرسالة ما بتضيع)
  db.prepare('INSERT INTO contact_messages (name, email, message) VALUES (?, ?, ?)')
    .run(name, email || null, message);

  // نحاول نبعت إيميل حقيقي، لو الإعدادات موجودة
  if (mailTransporter && process.env.CONTACT_EMAIL) {
    try {
      await mailTransporter.sendMail({
        from: `"بلدي — رسالة جديدة" <${process.env.GMAIL_USER}>`,
        to: process.env.CONTACT_EMAIL,
        replyTo: email || undefined,
        subject: `رسالة جديدة من ${name} — موقع بلدي`,
        text: `الاسم: ${name}\nالإيميل: ${email || 'ما انكتب'}\n\nالرسالة:\n${message}`
      });
    } catch (e) {
      console.error('فشل إرسال إيميل اتصل بنا:', e.message);
      // ما بنرجع خطأ للمستخدم — الرسالة محفوظة أصلاً بقاعدة البيانات
    }
  }

  res.status(201).json({ message: 'تم إرسال رسالتك بنجاح' });
});

// عرض رسائل "اتصل بنا" (للإدارة فقط)
app.get('/api/admin/contact-messages', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all();
  res.json(rows);
});

// حذف رسالة (للإدارة فقط)
app.delete('/api/admin/contact-messages/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM contact_messages WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'الرسالة غير موجودة' });
  res.json({ message: 'تم حذف الرسالة' });
});

// عرض تبليغات المنشورات (للإدارة فقط)
app.get('/api/admin/reports', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM post_reports ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({ ...r, post_snapshot: JSON.parse(r.post_snapshot) })));
});

// تجاهل/حذف تبليغ (بدون حذف المنشور نفسه)
app.delete('/api/admin/reports/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM post_reports WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'التبليغ غير موجود' });
  res.json({ message: 'تم تجاهل التبليغ' });
});

app.listen(PORT, () => {
  console.log(`بلدي backend شغال على http://localhost:${PORT}`);
});
