require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const morgan = require('morgan');
const sqlite3 = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const sharp = require('sharp');
const nodemailer = require('nodemailer');

const app = express();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite3');
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const db = sqlite3(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const uploadsDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const avatarsDir = path.join(__dirname, 'public', 'avatars');
fs.mkdirSync(avatarsDir, { recursive: true });

const imageDir = path.join(__dirname, 'public', 'image');
let homeImages = [];
try {
  homeImages = fs.readdirSync(imageDir)
    .filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f))
    .map(f => '/image/' + encodeURIComponent(f));
} catch (e) { homeImages = [] }

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
}));

app.use(flash());

app.use((req, res, next) => {
  res.locals.flashSuccess = req.flash('success');
  res.locals.flashError = req.flash('error');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo'];
const ALLOWED_MEDIA_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MEDIA_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format non autorise (images JPG/PNG/GIF/WebP ou videos MP4/WebM/OGG).'));
    }
  },
});

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format non autorise (JPG, PNG, GIF, WebP uniquement).'));
    }
  },
});

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS membres (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom_complet TEXT NOT NULL,
      lien_avec_manrouf TEXT,
      nom_pere TEXT NOT NULL,
      nom_mere TEXT NOT NULL,
      telephone TEXT NOT NULL,
      ville_habitation TEXT NOT NULL,
      pays_habitation TEXT NOT NULL,
      origine_mayotte_commune TEXT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      id_parent INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (id_parent) REFERENCES membres(id)
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      membre_id INTEGER NOT NULL,
      image_path TEXT NOT NULL,
      lieu_photo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (membre_id) REFERENCES membres(id) ON DELETE CASCADE
    );
  `);

  const email = 'manrouf@example.com';
  const exists = db.prepare('SELECT 1 FROM membres WHERE email = ?').get(email);
  if (!exists) {
    const hash = bcrypt.hashSync('change-me-manrouf', 10);
    db.prepare(`
      INSERT INTO membres (nom_complet, lien_avec_manrouf, nom_pere, nom_mere,
        telephone, ville_habitation, pays_habitation, origine_mayotte_commune,
        email, password_hash, id_parent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run('MOENDADZE Manroufou', 'Fondateur', 'Inconnu', 'Inconnue',
      '0000000000', '\u2014', 'Mayotte', null, email, hash);
  }
}

initDb();

function migrateDb() {
  try { db.exec('ALTER TABLE membres ADD COLUMN avatar TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE membres ADD COLUMN fonction TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE membres ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE membres ADD COLUMN date_naissance TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE photos ADD COLUMN album_id INTEGER'); } catch (e) {}
  try { db.exec("ALTER TABLE photos ADD COLUMN video_url TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE photos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'photo'"); } catch (e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT NOT NULL,
      description TEXT,
      membre_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (membre_id) REFERENCES membres(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      membre_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (membre_id) REFERENCES membres(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id INTEGER NOT NULL,
      membre_id INTEGER NOT NULL,
      contenu TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE,
      FOREIGN KEY (membre_id) REFERENCES membres(id) ON DELETE CASCADE
    );
  `);

  // Ensure Manrouf is admin (safe even if column just added)
  try { db.prepare('UPDATE membres SET is_admin = 1 WHERE email = ?').run('manrouf@example.com') } catch (e) {}
}

migrateDb();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ethereal.email',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    req.flash('error', 'Vous devez etre connecte.');
    return res.redirect('/login');
  }
  next();
}

function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM membres WHERE id = ?').get(req.session.userId);
}

function isAdmin(req) {
  const u = currentUser(req);
  return u && (u.is_admin == 1 || u.is_admin === '1');
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    req.flash('error', 'Acces reserve aux administrateurs.');
    return res.redirect('/');
  }
  next();
}

// in-memory rate limiter
const loginAttempts = {};
function rateLimitLogin(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  if (!loginAttempts[ip]) loginAttempts[ip] = [];
  loginAttempts[ip] = loginAttempts[ip].filter(t => now - t < windowMs);
  if (loginAttempts[ip].length >= 5) return false;
  loginAttempts[ip].push(now);
  return true;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[\d\s\-+()]{6,20}$/;
const PWD_MIN = 6;

function validateRegistration(data) {
  const errors = [];
  if (!data.nom_complet || data.nom_complet.trim().length < 2)
    errors.push('Le nom complet est requis (min 2 caracteres).');
  if (!data.lien_avec_manrouf || data.lien_avec_manrouf.trim().length < 2)
    errors.push('Le lien avec Manroufou est requis.');
  if (!data.nom_pere || data.nom_pere.trim().length < 1)
    errors.push('Le nom du pere est requis.');
  if (!data.nom_mere || data.nom_mere.trim().length < 1)
    errors.push('Le nom de la mere est requis.');
  const phoneFull = ((data.phone_code || '') + (data.phone_number || '')).trim();
  if (!phoneFull || !PHONE_RE.test(phoneFull))
    errors.push('Numero de telephone invalide.');
  if (!data.ville_habitation || data.ville_habitation.trim().length < 1)
    errors.push('La ville est requise.');
  if (!data.pays_habitation || data.pays_habitation.trim().length < 1)
    errors.push('Le pays est requis.');
  if (!data.email || !EMAIL_RE.test(data.email.trim()))
    errors.push('Email invalide.');
  if (!data.password || data.password.length < PWD_MIN)
    errors.push(`Mot de passe trop court (min ${PWD_MIN} caracteres).`);
  return errors;
}

function flashHtml(flashSuccess, flashError) {
  const out = [];
  for (const m of flashSuccess || []) out.push(`<div class="flash flash-success">${e(m)}</div>`);
  for (const m of flashError || []) out.push(`<div class="flash flash-error">${e(m)}</div>`);
  return out.join('');
}

function e(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function avatarHtml(nomComplet, size, avatarPath) {
  if (avatarPath) {
    return `<span class="avatar-link" onclick="openAvatarLightbox('/avatars/${e(avatarPath)}')"><img src="/avatars/${e(avatarPath)}" alt="${e(nomComplet)}" class="avatar-img avatar-${size || 'md'}"/></span>`;
  }
  const letter = (nomComplet || '?')[0].toUpperCase();
  return `<div class="avatar avatar-${size || 'md'}" aria-hidden="true">${letter}</div>`;
}

function svgIcon(name) {
  const S = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  const E = '</svg>';
  const icons = {
    phone: S + '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>' + E,
    location: S + '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>' + E,
    mail: S + '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>' + E,
    home: S + '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' + E,
    user: S + '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' + E,
    work: S + '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>' + E,
    users: S + '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' + E,
    lock: S + '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' + E,
    image: S + '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>' + E,
    calendar: S + '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' + E,
    star: S + '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' + E,
    album: S + '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' + E,
    comment: S + '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' + E,
    stats: S + '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>' + E,
    search: S + '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' + E,
    shield: S + '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' + E,
    cake: S + '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="M12 3V1"/><path d="M9 18v-4"/><path d="M15 18v-4"/>' + E,
    play: S + '<polygon points="5 3 19 12 5 21 5 3"/>' + E,
  };
  return '<span class="ico">' + (icons[name] || icons.location) + '</span>';
}

const COUNTRY_CODES = [
  ['Madagascar', '+261'], ['Mayotte', '+262'], ['Comores', '+269'],
  ['France', '+33'], ['La Reunion', '+262'], ['Maurice', '+230'],
  ['Seychelles', '+248'], ['Belgique', '+32'], ['Suisse', '+41'],
  ['Canada', '+1'], ['Etats-Unis', '+1'], ['Royaume-Uni', '+44'],
  ['Allemagne', '+49'], ['Espagne', '+34'], ['Italie', '+39'],
  ['Portugal', '+351'], ['Pays-Bas', '+31'], ['Maroc', '+212'],
  ['Tunisie', '+216'], ['Senegal', '+221'], ['Autre', ''],
];

const COUNTRIES = [
  'Mayotte', 'Madagascar', 'Comores', 'France', 'La Reunion',
  'Maurice', 'Seychelles', 'Belgique', 'Suisse', 'Canada',
  'Etats-Unis', 'Royaume-Uni', 'Allemagne', 'Espagne', 'Italie',
  'Portugal', 'Pays-Bas', 'Maroc', 'Tunisie', 'Algerie',
  'Senegal', 'Cote d\'Ivoire', 'Mali', 'Burkina Faso', 'Niger',
  'Tchad', 'Cameroun', 'Gabon', 'Congo', 'RDC',
  'Angola', 'Afrique du Sud', 'Bresil', 'Chine', 'Inde',
  'Australie', 'Japon', 'Autre',
];

function phoneGroupHtml(currentPhone) {
  let code = '+262', number = '';
  if (currentPhone) {
    const m = currentPhone.match(/^(\+\d{1,4})?\s*(.*)$/);
    if (m && m[1]) { code = m[1]; number = m[2]; }
    else number = currentPhone;
  }
  const opts = COUNTRY_CODES.map(([n, c]) => `<option value="${c}"${c === code ? ' selected' : ''}>${n} (${c || '--'})</option>`).join('');
  return `<div class="phone-group"><select name="phone_code" class="phone-code" required>${opts}</select><input name="phone_number" class="phone-number" value="${e(number)}" required placeholder="XX XX XX XX"/></div>`;
}

function countrySelectHtml(current) {
  return COUNTRIES.map(c => `<option value="${c}"${c === (current || 'Mayotte') ? ' selected' : ''}>${c}</option>`).join('');
}

function isActive(href, cp) {
  if (!cp) return '';
  if (href === '/' && cp === '/') return 'active';
  if (href !== '/' && cp.startsWith(href)) return 'active';
  return '';
}

function layout(title, user, body, flashSuccess, flashError, cp) {
  const nav = [
    ['/', 'Accueil'],
    ['/gallery', 'Galerie'],
    ['/members', 'Membres'],
    ['/famille/arbre', 'Arbre'],
    ['/albums', 'Albums'],
    ['/stats', 'Statistiques'],
    ['/profile', 'Mon profil'],
    ['/add-photo', 'Ajouter media'],
    ['/about', 'Nos racines'],
    (user && user.is_admin === 1) ? ['/admin', 'Admin'] : null,
  ].filter(Boolean);

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no"/>
<title>${e(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" crossorigin/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="/style.css"/>
<script src="/slideshow.js" defer></script>
<script src="/lightbox.js" defer></script>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <a href="/" class="brand-icon">M</a>
    <div class="brand-text">
      <div class="brand-title">Manroufou et les enfants de Mayotte</div>
      <div class="brand-sub">Bariza dans la famille MOENDADZE</div>
    </div>
  </div>
  <input type="checkbox" id="menuToggle" class="menu-toggle" autocomplete="off" />
  <label for="menuToggle" class="menu-btn" aria-label="Menu"><span></span></label>
  <nav class="menu">
    ${nav.map(([h, l]) => `<a href="${h}" class="${isActive(h, cp)}">${l}</a>`).join('')}
  </nav>
  <div class="authbar">${user
    ? `Connecte: <strong>${e(user.nom_complet)}</strong> <span class="authsep">|</span> <a href="/logout">Deconnexion</a>`
    : `<a href="/login">Connexion</a> <span class="authsep">|</span> <a href="/register">Inscription</a>`}</div>
</header>
<main class="container">
${flashHtml(flashSuccess, flashError)}
${body}
</main>
<footer class="footer">© ${new Date().getFullYear()} — Racines de Mayotte</footer>
<div id="avatarLightbox" class="lightbox" onclick="closeAvatarLightbox()">
  <span class="lightbox-close">&times;</span>
  <div class="lightbox-content avatar-lightbox-content" onclick="event.stopPropagation()">
    <img id="avatarLightboxImg" src="" alt="Photo de profil"/>
  </div>
</div>
</body>
</html>`;
}

function memberKicker(m) {
  const isManrouf = m.email === 'manrouf@example.com';
  if (isManrouf) {
    return `<div class="card-kicker"><strong>Fondateur</strong> — Mayotte</div>`;
  }
  const lien = m.lien_avec_manrouf ? e(m.lien_avec_manrouf) : 'Membre de la famille';
  return `
    <div class="card-kicker">
      <div><strong>Fils/fille de :</strong> ${e(m.nom_pere)} &amp; ${e(m.nom_mere)}</div>
      <div><strong>Lien :</strong> ${lien} — <span class="accent">Mayotte</span></div>
    </div>`;
}

function parseVideoUrl(url) {
  if (!url) return null;
  let m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
  if (m) return { platform: 'youtube', id: m[1], embedUrl: `https://www.youtube.com/embed/${m[1]}`, thumb: `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` };
  m = url.match(/vimeo\.com\/(\d+)/);
  if (m) return { platform: 'vimeo', id: m[1], embedUrl: `https://player.vimeo.com/video/${m[1]}`, thumb: null };
  return null;
}

function renderPhotoGrid(photos, showAlbum) {
  if (!photos || photos.length === 0) return '<p class="muted">Aucun media pour le moment.</p>';
  return photos.map(p => {
    if (p.media_type === 'video') {
      return `
        <div class="photo" data-photo-id="${p.id}" data-local-video="/uploads/${e(p.image_path)}" onclick="openLightbox(${p.id})">
          <div class="video-thumb">
            <video src="/uploads/${e(p.image_path)}" preload="metadata" muted playsinline style="width:100%;aspect-ratio:4/3;object-fit:cover;background:var(--surface);display:block"></video>
            <div class="play-overlay">${svgIcon('play')}</div>
          </div>
          <div class="photo-meta">
            ${p.nom_complet ? `<div>${svgIcon('user')} ${e(p.nom_complet)}</div>` : ''}
            <div>${svgIcon('location')} ${p.lieu_photo ? e(p.lieu_photo) : '\u2014'}</div>
            <div>${svgIcon('comment')} ${p.comment_count || 0} commentaire${(p.comment_count || 0) > 1 ? 's' : ''}</div>
            <div>${e(p.created_at)}</div>
            ${showAlbum && p.album_nom ? `<div>${svgIcon('album')} ${e(p.album_nom)}</div>` : ''}
          </div>
        </div>`;
    }
    const vid = parseVideoUrl(p.video_url);
    if (vid) {
      const thumb = vid.thumb || '/uploads/' + e(p.image_path);
      return `
        <div class="photo" data-photo-id="${p.id}" data-video="${vid.embedUrl}" onclick="openLightbox(${p.id})">
          <div class="video-thumb">
            <img src="${thumb}" alt="Video" loading="lazy"/>
            <div class="play-overlay">${svgIcon('play')}</div>
          </div>
          <div class="photo-meta">
            ${p.nom_complet ? `<div>${svgIcon('user')} ${e(p.nom_complet)}</div>` : ''}
            <div>${svgIcon('location')} ${p.lieu_photo ? e(p.lieu_photo) : '\u2014'}</div>
            <div>${svgIcon('comment')} ${p.comment_count || 0} commentaire${(p.comment_count || 0) > 1 ? 's' : ''}</div>
            <div>${e(p.created_at)}</div>
            ${showAlbum && p.album_nom ? `<div>${svgIcon('album')} ${e(p.album_nom)}</div>` : ''}
          </div>
        </div>`;
    }
    return `
      <div class="photo" data-photo-id="${p.id}" onclick="openLightbox(${p.id})">
        <a href="/uploads/${e(p.image_path)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">
          <img src="/uploads/${e(p.image_path)}" alt="Photo" loading="lazy"/>
        </a>
        <div class="photo-meta">
          ${p.nom_complet ? `<div>${svgIcon('user')} ${e(p.nom_complet)}</div>` : ''}
          <div>${svgIcon('location')} ${p.lieu_photo ? e(p.lieu_photo) : '\u2014'}</div>
          <div>${svgIcon('comment')} ${p.comment_count || 0} commentaire${(p.comment_count || 0) > 1 ? 's' : ''}</div>
          <div>${e(p.created_at)}</div>
          ${showAlbum && p.album_nom ? `<div>${svgIcon('album')} ${e(p.album_nom)}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- Routes ---

app.get('/', (req, res) => {
  const user = currentUser(req);
  const topMembers = db.prepare(`
    SELECT nom_complet, lien_avec_manrouf, ville_habitation, pays_habitation, id
    FROM membres ORDER BY created_at ASC LIMIT 5
  `).all();

  const slideshowHtml = homeImages.length > 0 ? `
    <div class="hero-map">
      <div class="slideshow" id="heroSlideshow">
        <div class="slideshow-badge">Mayotte</div>
        ${homeImages.map(url => `<img src="${url}" alt="Souvenir de Mayotte" loading="lazy"/>`).join('')}
      </div>
    </div>` : '';

  const mosaicHtml = homeImages.length > 0 ? `
    <section class="mosaic-section fade-in">
      <h2 class="section-heading">Souvenirs de famille</h2>
      <div class="photo-mosaic">
        ${homeImages.slice(0, 5).map((url, i) => `
          <div class="mosaic-item mosaic-item-${i + 1}">
            <img src="${url}" alt="Souvenir familial" loading="lazy"/>
            <div class="mosaic-overlay"><span>Souvenir</span></div>
          </div>`).join('')}
      </div>
      <a href="/gallery" class="btn btn-ghost btn-small" style="margin-top:16px">Voir toute la galerie</a>
    </section>` : '';

  const body = `
    <section class="hero fade-in">
      <div class="hero-text slide-up">
        <h1>Bienvenue dans l’heritage de <span class="accent">MOENDADZE Manroufou</span></h1>
        <p>Notre famille vient de <strong>Mayotte</strong> — chacun peut se presenter, partager des photos, et retrouver les autres membres.</p>
        <blockquote>"Notre famille vient de Mayotte, par MOENDADZE Manroufou"</blockquote>
        <div class="hero-cta">
          ${user ? `<a class="btn btn-pulse" href="/profile">Mon profil</a>` : `<a class="btn btn-pulse" href="/register">Rejoindre la famille</a>`}
          <a class="btn btn-ghost" href="/gallery">Voir la galerie</a>
        </div>
      </div>
      ${slideshowHtml}
    </section>

    ${mosaicHtml}

    <section class="grid-2 fade-in">
      <div class="panel slide-up" style="animation-delay:.1s">
        <h2 class="section-heading">Membres recents</h2>
        ${topMembers.map(m => `<div class="mini-member">${svgIcon('user')}<a href="/members/${m.id}">${e(m.nom_complet)}</a> — ${e(m.ville_habitation)}, ${e(m.pays_habitation)}</div>`).join('')}
        <a href="/members" class="btn btn-small" style="margin-top:10px;display:inline-block">${svgIcon('users')} Voir tous</a>
      </div>
      <div class="panel slide-up" style="animation-delay:.2s">
        <h2 class="section-heading">Nos racines</h2>
        <p>${svgIcon('location')} Une page dediee a l’histoire de MOENDADZE Manroufou, avec une biographie courte et la fierte mahoraise.</p>
        <a href="/about">${svgIcon('home')} Decouvrir</a>
      </div>
    </section>
  `;
  res.send(layout('Accueil', user, body, null, null, req.path));
});

app.get('/about', (req, res) => {
  const user = currentUser(req);
  const count = db.prepare('SELECT COUNT(*) c FROM membres').get().c;
  const body = `
    <section class="panel">
      <h2 class="section-heading" style="font-size:1.4rem">Nos racines — Mayotte</h2>
      <h2>MOENDADZE Manroufou</h2>
      <p>MOENDADZE Manroufou, originaire de <strong>Mayotte</strong>, est le grand-pere fondateur. Toute la famille descend de lui ou se rattache a son heritage.</p>
      <div class="about-photo"></div>
      <p>${svgIcon('users')} Aujourd’hui, <strong>${count} membres</strong> sont inscrits dans l’arbre familial.</p>
      <div class="cite">"Notre famille vient de Mayotte, par MOENDADZE Manroufou"</div>
      <p>${svgIcon('location')} Couleurs du site : <span class="accent">bleu</span> (ocean Indien &amp; iles de Mayotte).</p>
    </section>`;
  res.send(layout('Nos racines', user, body, null, null, req.path));
});

app.get('/register', (req, res) => {
  const user = currentUser(req);
  if (user) return res.redirect('/profile');
  const body = `
    <section class="panel">
      <h2 class="section-heading" style="font-size:1.4rem">Inscription</h2>
      <form method="POST" action="/register">
        <div class="form-grid">
          <label>${svgIcon('user')} Nom complet *<input name="nom_complet" required minlength="2"/></label>
          <label>${svgIcon('users')} Lien avec Manroufou *<input name="lien_avec_manrouf" required placeholder="ex: petit-fils, arriere-petit-fils..."/></label>
          <label>${svgIcon('user')} Nom du pere *<input name="nom_pere" required/></label>
          <label>${svgIcon('user')} Nom de la mere *<input name="nom_mere" required/></label>
          <label>${svgIcon('phone')} Telephone * ${phoneGroupHtml()}</label>
          <label>${svgIcon('home')} Ville *<input name="ville_habitation" required/></label>
          <label>${svgIcon('location')} Pays *<select name="pays_habitation" required>${countrySelectHtml()}</select></label>
          <label>${svgIcon('work')} Fonction / Metier (optionnel)<input name="fonction" placeholder="ex: Enseignant, Pecheur..."/></label>
          <label>${svgIcon('location')} Origine (optionnel)<input name="origine_mayotte_commune" placeholder="ex: Mamoudzou, Koungou..."/></label>
          <label>${svgIcon('mail')} Email *<input type="email" name="email" required/></label>
          <label>${svgIcon('lock')} Mot de passe *<input type="password" name="password" required minlength="${PWD_MIN}"/></label>
          <label>Parent (optionnel)<select name="id_parent">
            <option value="">\u2014 Aucun \u2014</option>
            ${db.prepare('SELECT id, nom_complet FROM membres ORDER BY nom_complet').all().map(m => `<option value="${m.id}">${e(m.nom_complet)}</option>`).join('')}
          </select></label>
        </div>
        <button class="btn" type="submit">Creer mon compte</button>
      </form>
    </section>`;
  res.send(layout('Inscription', user, body, null, null, req.path));
});

app.post('/register', asyncHandler(async (req, res) => {
  const d = req.body;
  const errors = validateRegistration(d);
  if (errors.length > 0) {
    errors.forEach(err => req.flash('error', err));
    return res.redirect('/register');
  }

  const exists = db.prepare('SELECT id FROM membres WHERE email = ?').get(d.email);
  if (exists) {
    req.flash('error', 'Cet email est deja utilise.');
    return res.redirect('/register');
  }

  const password_hash = bcrypt.hashSync(d.password, 10);
  const telephone = (d.phone_code || '') + ' ' + (d.phone_number || '').trim();
  const info = db.prepare(`
    INSERT INTO membres (nom_complet, lien_avec_manrouf, nom_pere, nom_mere,
      telephone, ville_habitation, pays_habitation, origine_mayotte_commune,
      email, password_hash, id_parent, fonction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.nom_complet.trim(), d.lien_avec_manrouf.trim(),
    d.nom_pere.trim(), d.nom_mere.trim(),
    telephone, d.ville_habitation.trim(),
    d.pays_habitation.trim(), d.origine_mayotte_commune?.trim() || null,
    d.email.trim(), password_hash,
    d.id_parent || null,
    d.fonction?.trim() || null
  );

  req.session.userId = info.lastInsertRowid;
  req.flash('success', 'Inscription reussie ! Bienvenue dans la famille.');
  res.redirect('/profile');
}));

app.get('/login', (req, res) => {
  const user = currentUser(req);
  if (user) return res.redirect('/profile');
  const body = `
    <section class="panel">
      <h2 class="section-heading" style="font-size:1.4rem">Connexion</h2>
      <form method="POST" action="/login">
        <label>${svgIcon('mail')} Email <input type="email" name="email" required/></label>
        <label>${svgIcon('lock')} Mot de passe <input type="password" name="password" required/></label>
        <button class="btn" type="submit">Se connecter</button>
      </form>
      <p style="margin-top:14px"><a href="/register">Pas encore inscrit ?</a> &middot; <a href="/forgot-password">Mot de passe oublié ?</a></p>
    </section>`;
  res.send(layout('Connexion', user, body, null, null, req.path));
});

app.post('/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimitLogin(ip)) {
    req.flash('error', 'Trop de tentatives. Reessayez dans 15 minutes.');
    return res.redirect('/login');
  }
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM membres WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.flash('error', 'Email ou mot de passe incorrect.');
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  req.flash('success', `Bon retour ${user.nom_complet} !`);
  res.redirect('/profile');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/forgot-password', (req, res) => {
  const user = currentUser(req);
  if (user) return res.redirect('/profile');
  const body = `
    <section class="panel">
      <h2 class="section-heading" style="font-size:1.4rem">Mot de passe oublie</h2>
      <form method="POST" action="/forgot-password">
        <label>${svgIcon('mail')} Votre email <input type="email" name="email" required/></label>
        <button class="btn" type="submit">Envoyer le lien</button>
      </form>
      <p style="margin-top:14px"><a href="/login">Retour a la connexion</a></p>
    </section>`;
  res.send(layout('Mot de passe oublie', user, body, null, null, req.path));
});

app.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = req.body;
  const membre = db.prepare('SELECT id, nom_complet, email FROM membres WHERE email = ?').get(email);
  if (!membre) {
    req.flash('success', 'Si cet email existe, un lien de reinitialisation a ete envoye.');
    return res.redirect('/login');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO reset_tokens (membre_id, token, expires_at) VALUES (?, ?, ?)').run(membre.id, token, expires);
  const resetUrl = `${req.protocol}://${req.hostname}:${PORT}/reset-password/${token}`;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"Famille" <noreply@famille-mayotte.fr>',
      to: membre.email,
      subject: 'Reinitialisation de votre mot de passe',
      text: `Bonjour ${membre.nom_complet},\n\nCliquez sur ce lien pour reinitialiser votre mot de passe :\n${resetUrl}\n\nCe lien expire dans 1 heure.\n\n— Famille Mayotte`,
    });
  } catch (e) { console.error('Email send error:', e.message) }
  req.flash('success', 'Si cet email existe, un lien de reinitialisation a ete envoye.');
  res.redirect('/login');
}));

app.get('/reset-password/:token', (req, res) => {
  const user = currentUser(req);
  const row = db.prepare('SELECT * FROM reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime(\'now\')').get(req.params.token);
  if (!row) {
    req.flash('error', 'Lien invalide ou expire.');
    return res.redirect('/login');
  }
  const body = `
    <section class="panel">
      <h2 class="section-heading" style="font-size:1.4rem">Nouveau mot de passe</h2>
      <form method="POST" action="/reset-password/${e(req.params.token)}">
        <label>${svgIcon('lock')} Nouveau mot de passe <input type="password" name="password" required minlength="${PWD_MIN}"/></label>
        <label>${svgIcon('lock')} Confirmer <input type="password" name="confirm" required/></label>
        <button class="btn" type="submit">Reinitialiser</button>
      </form>
    </section>`;
  res.send(layout('Reinitialisation', user, body, null, null, req.path));
});

app.post('/reset-password/:token', asyncHandler(async (req, res) => {
  const row = db.prepare('SELECT * FROM reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime(\'now\')').get(req.params.token);
  if (!row) {
    req.flash('error', 'Lien invalide ou expire.');
    return res.redirect('/login');
  }
  const { password, confirm } = req.body;
  if (password.length < PWD_MIN) {
    req.flash('error', `Min ${PWD_MIN} caracteres.`);
    return res.redirect(`/reset-password/${e(req.params.token)}`);
  }
  if (password !== confirm) {
    req.flash('error', 'Les mots de passe ne correspondent pas.');
    return res.redirect(`/reset-password/${e(req.params.token)}`);
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE membres SET password_hash = ? WHERE id = ?').run(hash, row.membre_id);
  db.prepare('UPDATE reset_tokens SET used = 1 WHERE id = ?').run(row.id);
  req.flash('success', 'Mot de passe reinitialise. Connectez-vous.');
  res.redirect('/login');
}));

app.get('/profile', requireAuth, (req, res) => {
  const user = currentUser(req);
  const photos = db.prepare('SELECT * FROM photos WHERE membre_id = ? ORDER BY id DESC LIMIT 50').all(user.id);
  const parent = user.id_parent ? db.prepare('SELECT nom_complet FROM membres WHERE id = ?').get(user.id_parent) : null;
  const children = db.prepare('SELECT id, nom_complet FROM membres WHERE id_parent = ?').all(user.id);

  const body = `
    <div class="profile-cover">
      <div class="profile-cover-inner">
        <div class="profile-avatar-wrap">
          ${avatarHtml(user.nom_complet, 'xl', user.avatar)}
        </div>
        <div class="profile-heading">
          <h1>${e(user.nom_complet)}${user.is_admin ? ` <span class="admin-badge">Admin</span>` : ''}</h1>
          ${user.fonction ? `<div class="profile-fonction">${svgIcon('work')} ${e(user.fonction)}</div>` : ''}
          <div class="profile-meta-line">
            <span>${svgIcon('home')} ${e(user.ville_habitation)}, ${e(user.pays_habitation)}</span>
            ${user.date_naissance ? `<span>${svgIcon('calendar')} ${e(user.date_naissance)}</span>` : ''}
          </div>
          <div class="btn-row" style="margin-top:10px">
            <a class="btn btn-small" href="/profile/edit">Modifier</a>
            <a class="btn btn-small btn-ghost" href="/profile/password">Changer mot de passe</a>
          </div>
        </div>
      </div>
    </div>

    <div class="profile-body">
      <div class="profile-sidebar">
        <div class="panel">
          <h3 class="section-heading" style="font-size:.95rem;margin-bottom:12px">${svgIcon('user')} Mes informations</h3>
          <div class="profile-info-list">
            <div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('mail')} Email</span>
              <span class="profile-info-value">${e(user.email)}</span>
            </div>
            <div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('phone')} Telephone</span>
              <span class="profile-info-value">${e(user.telephone)}</span>
            </div>
            <div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('location')} Origine</span>
              <span class="profile-info-value">${user.origine_mayotte_commune ? e(user.origine_mayotte_commune) : '\u2014'}</span>
            </div>
            <div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('users')} Lien</span>
              <span class="profile-info-value">${e(user.lien_avec_manrouf || 'Membre')}</span>
            </div>
            ${user.nom_pere ? `<div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('user')} Pere</span>
              <span class="profile-info-value">${e(user.nom_pere)}</span>
            </div>` : ''}
            ${user.nom_mere ? `<div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('user')} Mere</span>
              <span class="profile-info-value">${e(user.nom_mere)}</span>
            </div>` : ''}
            ${parent ? `<div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('users')} Parent</span>
              <span class="profile-info-value"><a href="/members/${user.id_parent}">${e(parent.nom_complet)}</a></span>
            </div>` : ''}
            ${children.length > 0 ? `<div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('users')} Enfants</span>
              <span class="profile-info-value">${children.map(c => `<a href="/members/${c.id}">${e(c.nom_complet)}</a>`).join(', ')}</span>
            </div>` : ''}
          </div>
        </div>
      </div>

      <div class="profile-main">
        <div class="panel">
          <h3 class="section-heading" style="font-size:.95rem;margin-bottom:12px">${svgIcon('image')} Mes medias (${photos.length})</h3>
          <div class="gallery">${renderPhotoGrid(photos)}</div>
        </div>
      </div>
    </div>`;
  res.send(layout('Mon profil', user, body, null, null, req.path));
});

app.get('/profile/edit', requireAuth, (req, res) => {
  const user = currentUser(req);
  const body = `
    <section class="panel">
      <h2 class="section-heading" style="font-size:1.4rem">Modifier mon profil</h2>
      <form method="POST" action="/profile/edit" enctype="multipart/form-data">
        <div class="form-grid">
          <label>Photo de profil
            <input type="file" name="avatar" accept="image/jpeg,image/png,image/gif,image/webp"/>
            ${user.avatar ? `<span class="muted" style="font-weight:400;text-transform:none">Actuelle : ${e(user.avatar)}</span>` : ''}
          </label>
          <label>Fonction / Metier <input name="fonction" value="${e(user.fonction || '')}" placeholder="ex: Enseignant, Pecheur..."/></label>
          <label>Nom complet <input name="nom_complet" value="${e(user.nom_complet)}" required/></label>
          <label>Lien avec Manroufou <input name="lien_avec_manrouf" value="${e(user.lien_avec_manrouf || '')}" required/></label>
          <label>Nom du pere <input name="nom_pere" value="${e(user.nom_pere)}" required/></label>
          <label>Nom de la mere <input name="nom_mere" value="${e(user.nom_mere)}" required/></label>
          <label>Telephone * ${phoneGroupHtml(user.telephone)}</label>
          <label>Date de naissance <input name="date_naissance" type="date" value="${e(user.date_naissance || '')}"/></label>
          <label>Ville <input name="ville_habitation" value="${e(user.ville_habitation)}" required/></label>
          <label>Pays *<select name="pays_habitation" required>${countrySelectHtml(user.pays_habitation)}</select></label>
          <label>Origine <input name="origine_mayotte_commune" value="${e(user.origine_mayotte_commune || '')}"/></label>
        </div>
        <button class="btn" type="submit">Enregistrer</button>
        <a class="btn btn-ghost" href="/profile">Annuler</a>
      </form>
    </section>`;
  res.send(layout('Modifier profil', user, body, null, null, req.path));
});

app.post('/profile/edit', requireAuth, (req, res) => {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) {
      req.flash('error', err.message || 'Erreur lors de l\'upload de l\'avatar.');
      return res.redirect('/profile/edit');
    }
    const user = currentUser(req);
    const d = req.body;
    let avatarName = user.avatar;
    if (req.file) {
      if (user.avatar) {
        try { fs.unlinkSync(path.join(avatarsDir, user.avatar)); } catch (e) {}
      }
      avatarName = req.file.filename;
    }
    const telephone = (d.phone_code || '').trim() + ' ' + (d.phone_number || '').trim();
    db.prepare(`
      UPDATE membres SET nom_complet=?, lien_avec_manrouf=?, nom_pere=?, nom_mere=?,
        telephone=?, date_naissance=?, ville_habitation=?, pays_habitation=?,
        origine_mayotte_commune=?, fonction=?, avatar=?
      WHERE id=?
    `).run(
      d.nom_complet.trim(), d.lien_avec_manrouf.trim(),
      d.nom_pere.trim(), d.nom_mere.trim(),
      telephone, d.date_naissance?.trim() || null,
      d.ville_habitation.trim(), d.pays_habitation.trim(),
      d.origine_mayotte_commune?.trim() || null,
      d.fonction?.trim() || null, avatarName,
      user.id
    );
    req.flash('success', 'Profil mis a jour.');
    res.redirect('/profile');
  });
});

app.get('/profile/password', requireAuth, (req, res) => {
  const user = currentUser(req);
  const body = `
    <section class="panel">
      <h2 class="section-heading" style="font-size:1.4rem">Changer mon mot de passe</h2>
      <form method="POST" action="/profile/password">
        <label>Mot de passe actuel <input type="password" name="current_password" required/></label>
        <label>Nouveau mot de passe <input type="password" name="new_password" required minlength="${PWD_MIN}"/></label>
        <label>Confirmer <input type="password" name="confirm_password" required/></label>
        <button class="btn" type="submit">Changer le mot de passe</button>
        <a class="btn btn-ghost" href="/profile">Annuler</a>
      </form>
    </section>`;
  res.send(layout('Changer mot de passe', user, body, null, null, req.path));
});

app.post('/profile/password', requireAuth, asyncHandler(async (req, res) => {
  const user = currentUser(req);
  const { current_password, new_password, confirm_password } = req.body;

  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    req.flash('error', 'Mot de passe actuel incorrect.');
    return res.redirect('/profile/password');
  }
  if (new_password.length < PWD_MIN) {
    req.flash('error', `Le mot de passe doit faire au moins ${PWD_MIN} caracteres.`);
    return res.redirect('/profile/password');
  }
  if (new_password !== confirm_password) {
    req.flash('error', 'Les mots de passe ne correspondent pas.');
    return res.redirect('/profile/password');
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE membres SET password_hash = ? WHERE id = ?').run(hash, user.id);
  req.flash('success', 'Mot de passe change avec succes.');
  res.redirect('/profile');
}));

app.get('/members', (req, res) => {
  const user = currentUser(req);
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 24;

  let where = '';
  const params = [];
  if (q) {
    where = `WHERE (m.nom_complet LIKE ? OR m.ville_habitation LIKE ? OR m.pays_habitation LIKE ? OR m.fonction LIKE ?)`;
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const total = db.prepare(`SELECT COUNT(*) c FROM membres m ${where}`).get(...params).c;
  const maxPage = Math.max(1, Math.ceil(total / perPage));

  const membres = db.prepare(`
    SELECT m.*, COUNT(p.id) AS photo_count
    FROM membres m
    LEFT JOIN photos p ON p.membre_id = m.id
    ${where}
    GROUP BY m.id
    ORDER BY m.nom_complet ASC LIMIT ? OFFSET ?
  `).all(...params, perPage, (page - 1) * perPage);

  const pagination = [];
  if (page > 1) pagination.push(`<a class="btn btn-small" href="/members?page=${page - 1}${q ? '&q=' + e(q) : ''}">Precedent</a>`);
  pagination.push(`<span class="page-info">Page ${page} / ${maxPage}</span>`);
  if (page < maxPage) pagination.push(`<a class="btn btn-small" href="/members?page=${page + 1}${q ? '&q=' + e(q) : ''}">Suivant</a>`);

  const body = `
    <section class="panel">
      <h1 class="section-heading">${svgIcon('users')} Membres (${total})</h1>
      <form method="GET" action="/members" class="search-form" style="margin-bottom:16px">
        <div class="search-box">
          ${svgIcon('search')}<input type="text" name="q" value="${e(q)}" placeholder="Nom, ville, pays, fonction..." class="search-input"/>
          <button class="btn btn-small" type="submit">Chercher</button>
          ${q ? `<a class="btn btn-small btn-ghost" href="/members">Effacer</a>` : ''}
        </div>
      </form>
      <div class="member-grid">
        ${membres.length === 0 ? '<p class="muted">Aucun membre trouve.</p>' : membres.map(m => `
          <a class="member-tile" href="/members/${m.id}">
            ${avatarHtml(m.nom_complet, 'md', m.avatar)}
            <div class="tile-name">${e(m.nom_complet)}</div>
            <div class="tile-sub">${e(m.lien_avec_manrouf || 'Membre')}</div>
            ${m.fonction ? `<div class="tile-sub" style="font-weight:400">${e(m.fonction)}</div>` : ''}
            <div class="tile-loc">${e(m.ville_habitation)} — ${e(m.pays_habitation)}</div>
            <div class="tile-photos">${m.photo_count} photo${m.photo_count > 1 ? 's' : ''}</div>
          </a>`).join('')}
      </div>
      ${total > perPage ? `<div class="pagination">${pagination.join('')}</div>` : ''}
    </section>`;
  res.send(layout('Membres', user, body, null, null, req.path));
});

app.get('/members/:id', (req, res) => {
  const user = currentUser(req);
  const m = db.prepare('SELECT * FROM membres WHERE id = ?').get(req.params.id);
  if (!m) {
    req.flash('error', 'Membre introuvable.');
    return res.redirect('/members');
  }

  const parent = m.id_parent ? db.prepare('SELECT id, nom_complet FROM membres WHERE id = ?').get(m.id_parent) : null;
  const children = db.prepare('SELECT id, nom_complet FROM membres WHERE id_parent = ?').all(m.id);
  const photos = db.prepare('SELECT * FROM photos WHERE membre_id = ? ORDER BY id DESC').all(m.id);
  const today = new Date();
  const isBirthday = m.date_naissance && m.date_naissance.slice(5) === today.toISOString().slice(5, 10);

  const body = `
    ${isBirthday ? `<div class="flash flash-success" style="margin-bottom:0">${svgIcon('cake')} Bon anniversaire ${e(m.nom_complet)} !</div>` : ''}
    <div class="profile-cover">
      <div class="profile-cover-inner">
        <div class="profile-avatar-wrap">
          ${avatarHtml(m.nom_complet, 'xl', m.avatar)}
        </div>
        <div class="profile-heading">
          <h1>${e(m.nom_complet)}${m.is_admin ? ` <span class="admin-badge">Admin</span>` : ''}</h1>
          ${m.fonction ? `<div class="profile-fonction">${svgIcon('work')} ${e(m.fonction)}</div>` : ''}
          <div class="profile-meta-line">
            <span>${svgIcon('home')} ${e(m.ville_habitation)}, ${e(m.pays_habitation)}</span>
            ${m.date_naissance ? `<span>${svgIcon('calendar')} ${e(m.date_naissance)}</span>` : ''}
          </div>
        </div>
      </div>
    </div>

    <div class="profile-body">
      <div class="profile-sidebar">
        <div class="panel">
          <h3 class="section-heading" style="font-size:.95rem;margin-bottom:12px">${svgIcon('user')} Informations</h3>
          <div class="profile-info-list">
            <div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('phone')} Telephone</span>
              <span class="profile-info-value">${e(m.telephone)}</span>
            </div>
            <div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('location')} Origine</span>
              <span class="profile-info-value">${m.origine_mayotte_commune ? e(m.origine_mayotte_commune) : '\u2014'}</span>
            </div>
            <div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('users')} Lien</span>
              <span class="profile-info-value">${e(m.lien_avec_manrouf || 'Membre')}</span>
            </div>
            ${m.nom_pere ? `<div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('user')} Pere</span>
              <span class="profile-info-value">${e(m.nom_pere)}</span>
            </div>` : ''}
            ${m.nom_mere ? `<div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('user')} Mere</span>
              <span class="profile-info-value">${e(m.nom_mere)}</span>
            </div>` : ''}
            ${parent ? `<div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('users')} Parent</span>
              <span class="profile-info-value"><a href="/members/${parent.id}">${e(parent.nom_complet)}</a></span>
            </div>` : ''}
            ${children.length > 0 ? `<div class="profile-info-item">
              <span class="profile-info-label">${svgIcon('users')} Enfants</span>
              <span class="profile-info-value">${children.map(c => `<a href="/members/${c.id}">${e(c.nom_complet)}</a>`).join(', ')}</span>
            </div>` : ''}
          </div>
        </div>
      </div>

      <div class="profile-main">
        <div class="panel">
          <h3 class="section-heading" style="font-size:.95rem;margin-bottom:12px">${svgIcon('image')} Galerie medias (${photos.length})</h3>
          <div class="gallery">${renderPhotoGrid(photos)}</div>
        </div>
      </div>
    </div>`;
  res.send(layout('Membre', user, body, null, null, req.path));
});

app.get('/gallery', (req, res) => {
  const user = currentUser(req);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const albumId = parseInt(req.query.album) || 0;
  const perPage = 30;

  let where = '';
  const params = [];
  if (albumId) { where = 'WHERE p.album_id = ?'; params.push(albumId) }

  const total = db.prepare(`SELECT COUNT(*) c FROM photos p ${where}`).get(...params).c;
  const maxPage = Math.max(1, Math.ceil(total / perPage));

  const photos = db.prepare(`
    SELECT p.*, m.nom_complet, a.nom AS album_nom,
      (SELECT COUNT(*) FROM comments c WHERE c.photo_id = p.id) AS comment_count
    FROM photos p
    JOIN membres m ON m.id = p.membre_id
    LEFT JOIN albums a ON a.id = p.album_id
    ${where}
    ORDER BY p.id DESC LIMIT ? OFFSET ?
  `).all(...params, perPage, (page - 1) * perPage);

  const pagination = [];
  if (page > 1) pagination.push(`<a class="btn btn-small" href="/gallery?page=${page - 1}${albumId ? '&album=' + albumId : ''}">Precedent</a>`);
  pagination.push(`<span class="page-info">Page ${page} / ${maxPage}</span>`);
  if (page < maxPage) pagination.push(`<a class="btn btn-small" href="/gallery?page=${page + 1}${albumId ? '&album=' + albumId : ''}">Suivant</a>`);

  const albums = db.prepare('SELECT id, nom FROM albums ORDER BY nom').all();

  const body = `
    <section class="panel">
      <h1 class="section-heading">${svgIcon('image')} Galerie familiale</h1>
      <p class="muted" style="margin-top:-8px;margin-bottom:16px">Photos et videos partagees par la famille.</p>
      <div class="album-filter" style="margin-bottom:16px">
        <form method="GET" action="/gallery" class="search-form">
          ${svgIcon('album')} <select name="album" onchange="this.form.submit()" class="album-select">
            <option value="">Tous les albums</option>
            ${albums.map(a => `<option value="${a.id}"${albumId === a.id ? ' selected' : ''}>${e(a.nom)}</option>`).join('')}
          </select>
          ${albumId ? `<a class="btn btn-small btn-ghost" href="/gallery">Effacer</a>` : ''}
        </form>
      </div>
      ${total === 0 ? '<p class="muted">Aucun media. <a href="/add-photo">Ajoutez le premier !</a></p>' : ''}
      <div class="gallery" id="galleryGrid">${renderPhotoGrid(photos)}</div>
      ${total > perPage ? `<div class="pagination">${pagination.join('')}</div>` : ''}
    </section>
    <div id="lightbox" class="lightbox" onclick="closeLightbox()">
      <span class="lightbox-close">&times;</span>
      <div class="lightbox-content" onclick="event.stopPropagation()">
        <img id="lightboxImg" src="" alt="Photo" style="display:none"/>
        <iframe id="lightboxVideo" src="" frameborder="0" allowfullscreen style="display:none;width:100%;aspect-ratio:16/9;border-radius:8px"></iframe>
        <video id="lightboxLocalVideo" src="" controls playsinline style="display:none;width:100%;aspect-ratio:16/9;border-radius:8px;background:#000"></video>
        <div id="lightboxMeta" class="lightbox-meta"></div>
        <div id="lightboxComments" class="lightbox-comments"></div>
        <form id="lightboxCommentForm" class="lightbox-form" onsubmit="return submitComment(event)">
          <input type="hidden" id="commentPhotoId"/>
          <input type="text" id="commentInput" placeholder="Ecrire un commentaire..." required/>
          <button type="submit" class="btn btn-small">${svgIcon('comment')} Envoyer</button>
        </form>
      </div>
    </div>`;
  res.send(layout('Galerie', user, body, null, null, req.path));
});

// --- Albums ---

app.get('/albums', (req, res) => {
  const user = currentUser(req);
  const albums = db.prepare(`
    SELECT a.*, COUNT(p.id) AS photo_count
    FROM albums a LEFT JOIN photos p ON p.album_id = a.id
    GROUP BY a.id ORDER BY a.nom
  `).all();
  const body = `
    <section class="panel">
      <h1 class="section-heading">${svgIcon('album')} Albums</h1>
      <div class="album-grid">
        ${albums.map(a => `
          <a class="album-card" href="/gallery?album=${a.id}">
            <div class="album-card-icon">${svgIcon('album')}</div>
            <div class="album-card-name">${e(a.nom)}</div>
            <div class="album-card-count">${a.photo_count} photo${a.photo_count > 1 ? 's' : ''}</div>
            ${a.description ? `<div class="album-card-desc">${e(a.description)}</div>` : ''}
          </a>`).join('') || '<p class="muted">Aucun album.</p>'}
      </div>
      ${user ? `<a class="btn btn-small" href="/albums/new">${svgIcon('album')} Creer un album</a>` : ''}
    </section>`;
  res.send(layout('Albums', user, body, null, null, req.path));
});

app.get('/albums/new', requireAuth, (req, res) => {
  const user = currentUser(req);
  const body = `
    <section class="panel">
      <h2 class="section-heading" style="font-size:1.4rem">${svgIcon('album')} Nouvel album</h2>
      <form method="POST" action="/albums/new">
        <label>Nom *<input name="nom" required/></label>
        <label>Description <textarea name="description" rows="3"></textarea></label>
        <button class="btn" type="submit">Creer</button>
        <a class="btn btn-ghost" href="/albums">Annuler</a>
      </form>
    </section>`;
  res.send(layout('Nouvel album', user, body, null, null, req.path));
});

app.post('/albums/new', requireAuth, (req, res) => {
  const user = currentUser(req);
  db.prepare('INSERT INTO albums (nom, description, membre_id) VALUES (?, ?, ?)').run(
    req.body.nom.trim(), req.body.description?.trim() || null, user.id
  );
  req.flash('success', 'Album cree.');
  res.redirect('/albums');
});

// --- Comments API ---

app.get('/api/comments/:photoId', (req, res) => {
  const comments = db.prepare(`
    SELECT c.*, m.nom_complet FROM comments c
    JOIN membres m ON m.id = c.membre_id
    WHERE c.photo_id = ? ORDER BY c.id ASC
  `).all(req.params.photoId);
  res.json(comments);
});

app.post('/api/comments/:photoId', requireAuth, (req, res) => {
  const { contenu } = req.body;
  if (!contenu || contenu.trim().length < 1) return res.status(400).json({ error: 'Contenu requis' });
  db.prepare('INSERT INTO comments (photo_id, membre_id, contenu) VALUES (?, ?, ?)').run(
    req.params.photoId, req.session.userId, contenu.trim()
  );
  res.json({ ok: true });
});

// --- Stats ---

app.get('/stats', (req, res) => {
  const user = currentUser(req);
  const totalMembres = db.prepare('SELECT COUNT(*) c FROM membres').get().c;
  const totalPhotos = db.prepare('SELECT COUNT(*) c FROM photos').get().c;
  const totalAlbums = db.prepare('SELECT COUNT(*) c FROM albums').get().c;
  const totalComments = db.prepare('SELECT COUNT(*) c FROM comments').get().c;
  const topPays = db.prepare('SELECT pays_habitation, COUNT(*) c FROM membres GROUP BY pays_habitation ORDER BY c DESC LIMIT 5').all();
  const topVilles = db.prepare('SELECT ville_habitation, COUNT(*) c FROM membres GROUP BY ville_habitation ORDER BY c DESC LIMIT 5').all();
  const recentMembers = db.prepare('SELECT nom_complet, created_at FROM membres ORDER BY created_at DESC LIMIT 5').all();
  const birthdays = db.prepare("SELECT nom_complet, date_naissance, id FROM membres WHERE date_naissance IS NOT NULL AND substr(date_naissance,6) >= substr(date('now'),6) ORDER BY substr(date_naissance,6) LIMIT 5").all();

  const body = `
    <section class="panel">
      <h1 class="section-heading">${svgIcon('stats')} Statistiques</h1>
      <div class="stats-grid">
        <div class="stat-card">${svgIcon('users')} <span class="stat-num">${totalMembres}</span> Membres</div>
        <div class="stat-card">${svgIcon('image')} <span class="stat-num">${totalPhotos}</span> Photos</div>
        <div class="stat-card">${svgIcon('album')} <span class="stat-num">${totalAlbums}</span> Albums</div>
        <div class="stat-card">${svgIcon('comment')} <span class="stat-num">${totalComments}</span> Commentaires</div>
      </div>
      <div class="grid-2" style="margin-top:20px">
        <div>
          <h3>${svgIcon('location')} Top pays</h3>
          ${topPays.map(p => `<div class="stat-row"><span>${e(p.pays_habitation)}</span><span>${p.c}</span></div>`).join('')}
          <h3 style="margin-top:16px">${svgIcon('home')} Top villes</h3>
          ${topVilles.map(v => `<div class="stat-row"><span>${e(v.ville_habitation)}</span><span>${v.c}</span></div>`).join('')}
        </div>
        <div>
          <h3>${svgIcon('calendar')} Derniers inscrits</h3>
          ${recentMembers.map(m => `<div class="stat-row"><span>${e(m.nom_complet)}</span><span>${e(m.created_at)}</span></div>`).join('')}
          <h3 style="margin-top:16px">${svgIcon('cake')} Prochains anniversaires</h3>
          ${birthdays.length > 0 ? birthdays.map(b => `<div class="stat-row"><span><a href="/members/${b.id}">${e(b.nom_complet)}</a></span><span>${e(b.date_naissance)}</span></div>`).join('') : '<div class="muted">Aucun anniversaire a venir.</div>'}
        </div>
      </div>
    </section>`;
  res.send(layout('Statistiques', user, body, null, null, req.path));
});

// --- Admin ---

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const user = currentUser(req);
  const membres = db.prepare('SELECT id, nom_complet, email, is_admin, created_at FROM membres ORDER BY nom_complet').all();
  const photos = db.prepare(`
    SELECT p.*, m.nom_complet FROM photos p
    JOIN membres m ON m.id = p.membre_id ORDER BY p.id DESC LIMIT 30
  `).all();
  const body = `
    <section class="panel">
      <h1 class="section-heading">${svgIcon('shield')} Administration</h1>
      <h3>${svgIcon('users')} Membres (${membres.length})</h3>
      <div class="admin-table">
        <table>
          <tr><th>Nom</th><th>Email</th><th>Admin</th><th>Date</th><th>Actions</th></tr>
          ${membres.map(m => `
            <tr>
              <td><a href="/members/${m.id}">${e(m.nom_complet)}</a></td>
              <td>${e(m.email)}</td>
              <td>${m.is_admin ? 'Oui' : 'Non'}</td>
              <td>${e(m.created_at)}</td>
              <td>
                ${!m.is_admin ? `<a class="btn btn-small" href="/admin/set-admin/${m.id}">${svgIcon('shield')} Rendre admin</a>` : ''}
                ${m.is_admin && m.id !== 1 ? `<a class="btn btn-small btn-ghost" href="/admin/remove-admin/${m.id}">Retirer admin</a>` : ''}
              </td>
            </tr>`).join('')}
        </table>
      </div>
      <h3 style="margin-top:24px">${svgIcon('image')} Dernieres photos</h3>
      <div class="gallery">${photos.map(p => {
        const isLocalVideo = p.media_type === 'video';
        const vid = parseVideoUrl(p.video_url);
        const src = vid ? (vid.thumb || '/uploads/' + e(p.image_path)) : '/uploads/' + e(p.image_path);
        return `
        <div class="photo">
          ${isLocalVideo ? `<div class="video-thumb"><video src="/uploads/${e(p.image_path)}" preload="metadata" muted playsinline style="width:100%;aspect-ratio:4/3;object-fit:cover;background:var(--surface);display:block"></video><div class="play-overlay" style="font-size:20px">${svgIcon('play')}</div></div>`
          : vid ? `<div class="video-thumb"><img src="${src}" alt="Video" loading="lazy" style="aspect-ratio:4/3;object-fit:cover"/><div class="play-overlay" style="font-size:20px">${svgIcon('play')}</div></div>`
            : `<img src="/uploads/${e(p.image_path)}" alt="Photo" loading="lazy" style="aspect-ratio:4/3;object-fit:cover"/>`}
          <div class="photo-meta">
            <div>${e(p.nom_complet)}</div>
            <div>${e(p.created_at)}</div>
            <a class="btn btn-small btn-ghost" href="/admin/delete-photo/${p.id}" onclick="return confirm('Supprimer cette photo ?')">${svgIcon('lock')} Supprimer</a>
          </div>
        </div>`;
      }).join('')}
      </div>
    </section>`;
  res.send(layout('Administration', user, body, null, null, req.path));
});

app.get('/admin/set-admin/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('UPDATE membres SET is_admin = 1 WHERE id = ?').run(req.params.id);
  req.flash('success', 'Membre promu administrateur.');
  res.redirect('/admin');
});

app.get('/admin/remove-admin/:id', requireAuth, requireAdmin, (req, res) => {
  if (Number(req.params.id) === 1) { req.flash('error', 'Impossible de retirer les droits du fondateur.'); return res.redirect('/admin') }
  db.prepare('UPDATE membres SET is_admin = 0 WHERE id = ?').run(req.params.id);
  req.flash('success', 'Droits administrateur retires.');
  res.redirect('/admin');
});

app.get('/admin/delete-photo/:id', requireAuth, requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (p) {
    if (!p.video_url) { try { fs.unlinkSync(path.join(uploadsDir, p.image_path)); } catch (e) {} }
    db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);
  }
  req.flash('success', 'Media supprime.');
  res.redirect('/admin');
});

// --- Sharp auto-resize on upload ---
const sharpStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});

const uploadResized = multer({
  storage: sharpStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MEDIA_TYPES.includes(file.mimetype)) { cb(null, true) }
    else { cb(new Error('Format non autorise (images JPG/PNG/GIF/WebP ou videos MP4/WebM/OGG).')) }
  },
});

function insertPhoto(fields) {
  const cols = ['membre_id', 'image_path', 'lieu_photo', 'album_id'];
  const vals = [fields.membre_id, fields.image_path, fields.lieu_photo, fields.album_id];
  const opt = [];
  if (fields.media_type) opt.push('media_type');
  if (fields.video_url) opt.push('video_url');
  let sql = `INSERT INTO photos (${cols.concat(opt).join(',')}) VALUES (${cols.concat(opt).map(() => '?').join(',')})`;
  try {
    db.prepare(sql).run(...vals, ...(opt.map(k => fields[k])));
  } catch (e) {
    sql = `INSERT INTO photos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    db.prepare(sql).run(...vals);
  }
}

app.post('/add-photo', requireAuth, (req, res, next) => {
  uploadResized.single('photo')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        req.flash('error', 'Fichier trop volumineux (max 50 Mo).');
      } else { req.flash('error', err.message || 'Erreur lors de l\'upload.') }
      return res.redirect('/add-photo');
    }
    const videoUrl = (req.body?.video_url || '').trim();
    if (videoUrl) {
      const parsed = parseVideoUrl(videoUrl);
      if (!parsed) { req.flash('error', 'Lien video invalide (YouTube ou Vimeo attendu).'); return res.redirect('/add-photo') }
      insertPhoto({
        membre_id: req.session.userId,
        image_path: 'video_' + parsed.id + '.jpg',
        lieu_photo: (req.body?.lieu_photo || '').trim() || null,
        album_id: parseInt(req.body?.album_id) || null,
        video_url: videoUrl,
        media_type: 'video_link',
      });
      req.flash('success', 'Video publiee !');
      return res.redirect('/gallery');
    }
    if (!req.file) { req.flash('error', 'Selectionnez un fichier ou un lien video.'); return res.redirect('/add-photo') }
    const isVideo = ALLOWED_VIDEO_TYPES.includes(req.file.mimetype);
    if (!isVideo) {
      try {
        const outPath = path.join(uploadsDir, req.file.filename);
        const buf = await sharp(req.file.path).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
        fs.writeFileSync(outPath, buf);
        if (req.file.path !== outPath) try { fs.unlinkSync(req.file.path) } catch (e) {}
      } catch (e) { console.error('Sharp error:', e) }
    }
    insertPhoto({
      membre_id: req.session.userId,
      image_path: req.file.filename,
      lieu_photo: (req.body?.lieu_photo || '').trim() || null,
      album_id: parseInt(req.body?.album_id) || null,
      media_type: isVideo ? 'video' : 'photo',
    });
    req.flash('success', isVideo ? 'Video publiee !' : 'Photo publiee !');
    res.redirect('/gallery');
  });
});

app.get('/add-photo', requireAuth, (req, res) => {
  const user = currentUser(req);
  const albums = db.prepare('SELECT id, nom FROM albums ORDER BY nom').all();
  const body = `
    <section class="panel">
      <h2 class="section-heading" style="font-size:1.4rem">${svgIcon('image')} Ajouter un media</h2>
      <form method="POST" action="/add-photo" enctype="multipart/form-data">
        <div class="form-grid">
          <label>${svgIcon('image')} Fichier (photo ou video)<input type="file" name="photo" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/ogg,video/quicktime"/></label>
          <label>${svgIcon('play')} Video (lien YouTube/Vimeo)<input name="video_url" placeholder="https://youtube.com/watch?v=..."/></label>
          <label>${svgIcon('location')} Lieu (optionnel)<input name="lieu_photo" placeholder="ex: Chez tonton a Mayotte"/></label>
          <label>${svgIcon('album')} Album <select name="album_id">
            <option value="">\u2014 Aucun \u2014</option>
            ${albums.map(a => `<option value="${a.id}">${e(a.nom)}</option>`).join('')}
          </select></label>
        </div>
        <p class="muted">Photo : JPG/PNG/GIF/WebP (redimensionnee). Video : MP4/WebM/OGG/MOV ou lien YouTube/Vimeo. Max 50 Mo.</p>
        <button class="btn" type="submit">${svgIcon('image')} Publier</button>
        <a class="btn btn-ghost" href="/gallery">Annuler</a>
      </form>
    </section>`;
  res.send(layout('Ajouter media', user, body, null, null, req.path));
});

// Update tree filter
app.get('/famille/arbre', (req, res) => {
  const user = currentUser(req);
  const filterParentId = parseInt(req.query.parent_id) || 0;
  let all;
  if (filterParentId) {
    const ids = [filterParentId];
    function collectChildren(id) {
      const kids = db.prepare('SELECT id FROM membres WHERE id_parent = ?').all(id);
      for (const k of kids) { ids.push(k.id); collectChildren(k.id) }
    }
    collectChildren(filterParentId);
    all = db.prepare(`SELECT id, nom_complet, id_parent, lien_avec_manrouf FROM membres WHERE id IN (${ids.join(',')}) ORDER BY id`).all();
  } else {
    all = db.prepare('SELECT id, nom_complet, id_parent, lien_avec_manrouf FROM membres ORDER BY id').all();
  }

  const byParent = {};
  let root = null;
  for (const m of all) {
    if (!m.id_parent) root = m;
    else { if (!byParent[m.id_parent]) byParent[m.id_parent] = []; byParent[m.id_parent].push(m) }
  }

  function renderNode(nodeId, depth) {
    const m = all.find(x => x.id === nodeId);
    if (!m) return '';
    const kids = byParent[nodeId] || [];
    const isManrouf = root && root.id === nodeId;
    const cls = isManrouf ? 'tree-node tree-root' : 'tree-node';
    const childrenHtml = kids.map(k => renderNode(k.id, depth + 1)).join('');
    return `
      <div class="${cls}" style="margin-left:${depth * 28}px">
        <a href="/members/${m.id}">${e(m.nom_complet)}</a>
        <span class="tree-lien">${e(m.lien_avec_manrouf || '')}</span>
        ${childrenHtml ? `<div class="tree-children">${childrenHtml}</div>` : ''}
      </div>`;
  }

  const treeHtml = root ? renderNode(root.id, 0) : '<p class="muted">Aucun membre.</p>';
  const membres = db.prepare('SELECT id, nom_complet FROM membres ORDER BY nom_complet').all();

  const body = `
    <section class="panel">
      <h1 class="section-heading">${svgIcon('users')} Arbre genealogique</h1>
      <form method="GET" action="/famille/arbre" class="search-form" style="margin-bottom:16px">
        ${svgIcon('filter')} <select name="parent_id" onchange="this.form.submit()" class="album-select">
          <option value="">Arbre complet</option>
          ${membres.map(m => `<option value="${m.id}"${filterParentId === m.id ? ' selected' : ''}>${e(m.nom_complet)}</option>`).join('')}
        </select>
        ${filterParentId ? `<a class="btn btn-small btn-ghost" href="/famille/arbre">Effacer</a>` : ''}
      </form>
      <div class="tree">${treeHtml}</div>
    </section>`;
  res.send(layout('Arbre familial', user, body, null, null, req.path));
});

// remove old add-photo / gallery routes (they were already updated above)
// remove old gallery routes

app.use((req, res) => {
  res.status(404).send(layout('Page introuvable', null, '<div class="panel"><h1>404</h1><p>Page introuvable.</p><a href="/">Retour a l\'accueil</a></div>', null, null, req.path));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(layout('Erreur', null, '<div class="panel"><h1>Erreur</h1><p>Une erreur est survenue. Veuillez reessayer.</p><a href="/">Retour a l\'accueil</a></div>', null, null, req.path));
});

app.listen(PORT, () => {
  console.log(`Manroufou-Mayotte app running on http://localhost:${PORT}`);
});
