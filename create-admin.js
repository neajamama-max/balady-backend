// شغّل هاد الملف مرة وحدة لإنشاء أول حساب إدارة (محرر)
// الاستخدام: node create-admin.js اسم_المستخدم كلمة_المرور
// مثال:      node create-admin.js editor "MyStrongPassword123!"

const bcrypt = require('bcryptjs');
const path = require('path');
const Database = require('better-sqlite3');

const [,, username, password] = process.argv;

if (!username || !password) {
  console.log('الاستخدام: node create-admin.js اسم_المستخدم كلمة_المرور');
  process.exit(1);
}

if (password.length < 8) {
  console.log('كلمة المرور لازم تكون 8 أحرف على الأقل.');
  process.exit(1);
}

const db = new Database(path.join(__dirname, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );
`);

const hash = bcrypt.hashSync(password, 10);

try {
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`تم إنشاء حساب الإدارة "${username}" بنجاح.`);
} catch (e) {
  console.log('خطأ: ربما اسم المستخدم موجود مسبقاً.', e.message);
}
