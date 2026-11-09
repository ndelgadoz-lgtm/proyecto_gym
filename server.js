require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const ExcelJS = require("exceljs");
const { OAuth2Client } = require("google-auth-library");

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SESSION_DAYS = 30;
const COOKIE = "sid";

const SHEET = "Hoja 1";

// Los entrenos (cada archivo es un entreno distinto). El orden importa:
// se recorren uno tras otro en ciclo (Entreno 1 -> 2 -> repetir).
const ENTRENOS = [
  { key: "entreno7", name: "Entreno 1", file: "ENTRENO 7. 31-08-2026 (2).xlsx" },
  { key: "copia19", name: "Entreno 2", file: "Copia de ENTRENO 19 ( 5 DIAS).xlsx" },
];

// Cada cuenta de Google tiene su propia copia de los Excel dentro de data/.
// Los archivos de la raíz solo se usan como plantillas para la primera copia.
const USERS_DIR = path.join(__dirname, "data");
const userInitLocks = new Map();

function safeEmail(email) {
  const s = String(email || "")
    .toLowerCase()
    .replace(/[^a-z0-9@._-]/g, "_")
    .replace(/^\.+/, "_");
  if (!s || s === "." || s === "..") throw new Error("Email no válido");
  return s;
}

function userDir(email) {
  return path.join(USERS_DIR, safeEmail(email));
}

function userFile(email, cfg) {
  return path.join(userDir(email), `${cfg.key}.xlsx`);
}

function ensureUserFiles(email) {
  const dir = userDir(email);
  if (!userInitLocks.has(dir)) {
    const job = (async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      for (const cfg of ENTRENOS) {
        const dest = path.join(dir, `${cfg.key}.xlsx`);
        try {
          await fs.promises.copyFile(
            path.join(__dirname, cfg.file),
            dest,
            fs.constants.COPYFILE_EXCL
          );
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
      }
    })().finally(() => userInitLocks.delete(dir));
    userInitLocks.set(dir, job);
  }
  return userInitLocks.get(dir);
}

// Rejilla común: cada microciclo tiene su columna de objetivo y su columna
// en blanco (registro) justo al lado. La columna N (14, "Descansos") no se toca.
const MICROCICLOS = [
  { index: 0, name: "MICROCICLO 1", targetCol: 2, recordCol: 3 },
  { index: 1, name: "MICROCICLO 2", targetCol: 4, recordCol: 5 },
  { index: 2, name: "MICROCICLO 3", targetCol: 6, recordCol: 7 },
  { index: 3, name: "MICROCICLO 4", targetCol: 8, recordCol: 9 },
  { index: 4, name: "MICROCICLO 5", targetCol: 10, recordCol: 11 },
  { index: 5, name: "DESCARGA", targetCol: 12, recordCol: 13 },
];

// Fecha en la que empieza el ciclo (microciclo 1 del Entreno 1).
const CYCLE_START = new Date(process.env.START_DATE || "2026-10-15T00:00:00");
const MS_WEEK = 7 * 86400000;

const DAY_RE = /^Día\s*(\d+)\s*:\s*(.*)$/i;
const SETS_RE = /(\d+)\s*[xX×]/;
const HEADER_RE = /MICROCICLO|DESCARGA/i;

if (!CLIENT_ID) {
  console.error("Falta GOOGLE_CLIENT_ID en el archivo .env");
  process.exit(1);
}

/* ---------- Excel helpers ---------- */

function cellText(cell) {
  const v = cell && cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    return "";
  }
  return String(v);
}

function countSets(target) {
  const found = (target.match(new RegExp(SETS_RE, "g")) || []).map((s) =>
    parseInt(s, 10)
  );
  const sum = found.reduce((a, b) => a + b, 0);
  return found.length ? sum : 1;
}

function readMicrocicloDefs(ws) {
  // Nombres reales desde la fila cabecera; si falta, se usa el nombre por defecto.
  return MICROCICLOS.map((md) => {
    let name = md.name;
    for (let r = 1; r <= 3; r++) {
      const t = cellText(ws.getRow(r).getCell(md.targetCol)).trim();
      if (HEADER_RE.test(t)) {
        name = t;
        break;
      }
    }
    return { ...md, name };
  });
}

function parseDays(ws, microDefs) {
  const days = [];
  let current = null;

  ws.eachRow({ includeEmpty: false }, (row) => {
    const a = cellText(row.getCell(1)).trim();
    if (!a) return;

    const m = DAY_RE.exec(a);
    if (m) {
      current = {
        index: parseInt(m[1], 10),
        title: a,
        rest: /rest/i.test(m[2]),
        exercises: [],
      };
      days.push(current);
      return;
    }

    if (!current) return;

    // Solo es un ejercicio si tiene objetivo en algún microciclo.
    const targets = {};
    let hasTarget = false;
    for (const md of microDefs) {
      const t = cellText(row.getCell(md.targetCol)).trim();
      if (t) {
        targets[md.targetCol] = t;
        hasTarget = true;
      }
    }
    if (!hasTarget) return;

    current.exercises.push({ row: row.number, name: a, targets });
  });

  return days;
}

function buildMicrociclos(days, microDefs) {
  const out = [];
  for (const md of microDefs) {
    const list = [];
    for (const d of days) {
      const exercises = d.rest
        ? []
        : d.exercises
            .filter((e) => e.targets[md.targetCol])
            .map((e) => ({
              row: e.row,
              name: e.name,
              target: e.targets[md.targetCol],
              sets: countSets(e.targets[md.targetCol]),
            }));
      list.push({
        index: d.index,
        title: d.title,
        rest: d.rest,
        exercises,
      });
    }
    const total = list.reduce((a, d) => a + d.exercises.length, 0);
    if (total === 0) continue; // microciclo sin datos: no se muestra
    out.push({
      index: out.length,
      name: md.name,
      targetCol: md.targetCol,
      recordCol: md.recordCol,
      days: list,
    });
  }
  return out;
}

async function readEntrenoFromFile(file, cfg) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(SHEET) || wb.worksheets[0];
  const microDefs = readMicrocicloDefs(ws);
  const days = parseDays(ws, microDefs);
  const microciclos = buildMicrociclos(days, microDefs);
  return { key: cfg.key, name: cfg.name, file, microciclos, ws };
}

async function readEntreno(cfg, email) {
  await ensureUserFiles(email);
  return readEntrenoFromFile(userFile(email, cfg), cfg);
}

async function loadTemplates() {
  const entrenos = [];
  for (const cfg of ENTRENOS) {
    entrenos.push(await readEntrenoFromFile(path.join(__dirname, cfg.file), cfg));
  }
  return entrenos;
}

async function loadTrainings(email) {
  const entrenos = [];
  for (const cfg of ENTRENOS) {
    try {
      const e = await readEntreno(cfg, email);
      entrenos.push(e);
    } catch (err) {
      console.error(`No se pudo leer ${cfg.file}:`, err.message);
      entrenos.push({ key: cfg.key, name: cfg.name, file: cfg.file, microciclos: [] });
    }
  }
  return entrenos;
}

async function loadRecords(email) {
  const records = {};
  for (const cfg of ENTRENOS) {
    let e;
    try {
      e = await readEntreno(cfg, email);
    } catch (err) {
      console.error(`No se pudo leer ${cfg.file}:`, err.message);
      continue;
    }
    e.microciclos.forEach((mi) => {
      for (const d of mi.days) {
        for (const ex of d.exercises) {
          const v = cellText(e.ws.getRow(ex.row).getCell(mi.recordCol)).trim();
          if (v) records[`${cfg.key}|${mi.index}|${ex.row}`] = v;
        }
      }
    });
  }
  return records;
}

async function writeEntries(filePath, microIndex, clean) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet(SHEET) || wb.worksheets[0];
  const microDefs = readMicrocicloDefs(ws);
  const microciclos = buildMicrociclos(parseDays(ws, microDefs), microDefs);
  const mi = microciclos[microIndex];
  if (!mi) throw new Error("Microciclo inexistente");
  let count = 0;
  for (const item of clean) {
    ws.getRow(item.row).getCell(mi.recordCol).value = item.text;
    count++;
  }
  await wb.xlsx.writeFile(filePath);
  return count;
}

/* ---------- Formato de series ---------- */

function fmtNum(n) {
  const num = Number(n);
  return Number.isInteger(num) ? String(num) : String(parseFloat(num.toFixed(2)));
}

function fmtSets(sets) {
  return sets
    .filter((s) => s.kg !== null || s.reps !== null)
    .map((s) => {
      const kg = s.kg !== null ? `${fmtNum(s.kg)}kg` : "";
      const reps = s.reps !== null ? fmtNum(s.reps) : "";
      if (kg && reps) return `${kg} x ${reps}`;
      if (kg) return kg;
      return `${reps} reps`;
    })
    .join(" / ");
}

function toNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/* ---------- Sesiones / auth ---------- */

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sessions = new Map();

function createSession(res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...user, exp: Date.now() + SESSION_DAYS * 86400000 });
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
      SESSION_DAYS * 86400
    }`
  );
}

function getSessionUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  req.user = user;
  next();
}

/* ---------- Escritura serializada en los Excel ---------- */

let writeLock = Promise.resolve();
function withLock(fn) {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/* ---------- App ---------- */

function computeCurrent(entrenos) {
  const flat = [];
  for (const e of entrenos) {
    for (const mi of e.microciclos) flat.push({ entrenoKey: e.key, microIndex: mi.index });
  }
  if (!flat.length) return null;
  const now = new Date();
  const days = Math.floor((now - CYCLE_START) / 86400000);
  const pos = ((days % (flat.length * 7)) + flat.length * 7) % (flat.length * 7);
  const week = Math.floor(pos / 7);
  const cur = flat[week];
  return { entrenoKey: cur.entrenoKey, microIndex: cur.microIndex };
}

const oauth = new OAuth2Client(CLIENT_ID);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({ googleClientId: CLIENT_ID });
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential) {
      return res.status(400).json({ error: "Falta el credential token" });
    }
    const ticket = await oauth.verifyIdToken({ idToken: credential, audience: CLIENT_ID });
    const p = ticket.getPayload();
    if (!p.email) {
      return res.status(400).json({ error: "La cuenta de Google no tiene email" });
    }
    const user = { sub: p.sub, email: p.email, name: p.name || null, picture: p.picture || null };
    createSession(res, user);
    res.json({ email: user.email, name: user.name, picture: user.picture });
  } catch (err) {
    console.error("Error verificando token de Google:", err.message);
    res.status(401).json({ error: "Token de Google no válido" });
  }
});

app.get("/api/auth/me", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "No autenticado" });
  res.json({ email: user.email, name: user.name, picture: user.picture });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth/") || req.path === "/config") return next();
  requireAuth(req, res, next);
});

app.get("/api/trainings", async (req, res) => {
  try {
    const entrenos = await loadTrainings(req.user.email);
    const payload = entrenos.map((e) => ({
      key: e.key,
      name: e.name,
      microciclos: e.microciclos,
    }));
    res.json({ entrenos: payload, current: computeCurrent(payload) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudieron leer los entrenamientos" });
  }
});

app.get("/api/records", async (req, res) => {
  try {
    const records = await loadRecords(req.user.email);
    res.json({ records });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudieron leer los registros" });
  }
});

app.post("/api/save", async (req, res) => {
  const { entreno, microIndex, entries } = req.body || {};
  const cfg = ENTRENOS.find((e) => e.key === entreno);
  if (!cfg) return res.status(400).json({ error: "Entreno no válido" });
  if (!Number.isInteger(microIndex)) {
    return res.status(400).json({ error: "Microciclo no válido" });
  }
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: "Entries debe ser una lista" });
  }

  const clean = [];
  for (const e of entries) {
    if (!e || !Number.isInteger(e.row)) continue;
    const sets = Array.isArray(e.sets)
      ? e.sets.map((s) => ({ kg: toNum(s && s.kg), reps: toNum(s && s.reps) }))
      : [];
    const text = fmtSets(sets);
    if (!text) continue;
    clean.push({ row: e.row, text });
  }
  if (!clean.length) return res.json({ ok: true, saved: 0 });

  try {
    await ensureUserFiles(req.user.email);
    const file = userFile(req.user.email, cfg);
    const saved = await withLock(() => writeEntries(file, microIndex, clean));
    res.json({ ok: true, saved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo guardar en el Excel" });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor" });
});

setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.exp <= now) sessions.delete(token);
}, 3600000).unref();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Gym app arrancada en http://localhost:${PORT}`);
    loadTemplates()
      .then((es) => {
        const info = es
          .map((e) => `${e.name}: ${e.microciclos.length} microciclos`)
          .join(" | ");
        console.log(`Plantillas cargadas -> ${info}`);
      })
      .catch((err) => {
        console.error("No se pudieron leer las plantillas:", err.message);
      });
  });
}

module.exports = { loadTrainings, loadRecords, writeEntries };
