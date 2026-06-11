const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs   = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── DB init: create tables if not exist ──────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pin  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bets (
      id             TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      match_id       TEXT NOT NULL,
      score1         INTEGER,
      score2         INTEGER,
      UNIQUE(participant_id, match_id)
    );
    CREATE TABLE IF NOT EXISTS results (
      match_id TEXT PRIMARY KEY,
      score1   INTEGER,
      score2   INTEGER
    );
  `);
  // default admin pin
  await pool.query(`
    INSERT INTO config (key, value) VALUES ('admin_pin', '0000')
    ON CONFLICT (key) DO NOTHING;
  `);
}

// ── Matches (static JSON) ─────────────────────────────────────────────────────
const MATCHES_FILE = path.join(__dirname, '..', 'matches.json');
function loadMatches() {
  const data = JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf8'));
  return data.matches
    .map((m, i) => ({ ...m, id: String(m.num !== undefined ? m.num : i) }))
    .sort((a, b) => (a.date || '') < (b.date || '') ? -1 : 1);
}

// ── Scoring ───────────────────────────────────────────────────────────────────
function calcScore(b1, b2, s1, s2) {
  if (s1 === null || s2 === null) return 0;
  b1 = parseInt(b1); b2 = parseInt(b2);
  s1 = parseInt(s1); s2 = parseInt(s2);
  if (isNaN(b1) || isNaN(b2)) return 0;
  if (b1 === s1 && b2 === s2) return 3;
  const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;
  return sign(b1 - b2) === sign(s1 - s2) ? 1 : 0;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function getAdminPin() {
  const r = await pool.query(`SELECT value FROM config WHERE key = 'admin_pin'`);
  return r.rows[0]?.value || '0000';
}

function requireAdmin(req, res, adminPin) {
  const pin = req.headers['x-admin-pin'];
  if (String(pin) !== String(adminPin)) {
    res.status(401).json({ error: 'PIN de admin incorreto' });
    return false;
  }
  return true;
}

// ── Router ────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-pin,x-participant-pin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initDB();
  } catch (e) {
    return res.status(500).json({ error: 'DB init failed: ' + e.message });
  }

  const url = (req.url || '').replace(/^\/api/, '').split('?')[0];
  const method = req.method;

  // ── GET /matches ────────────────────────────────────────────────────────────
  if (url === '/matches' && method === 'GET') {
    const matches = loadMatches();
    const results = await pool.query('SELECT * FROM results');
    const resMap  = {};
    results.rows.forEach(r => { resMap[r.match_id] = { score1: r.score1, score2: r.score2 }; });
    return res.json(matches.map(m => ({ ...m, result: resMap[m.id] || null })));
  }

  // ── PUT /matches/:id/result ─────────────────────────────────────────────────
  const matchResult = url.match(/^\/matches\/([^/]+)\/result$/);
  if (matchResult && method === 'PUT') {
    const adminPin = await getAdminPin();
    if (!requireAdmin(req, res, adminPin)) return;
    const id = matchResult[1];
    const { score1, score2 } = req.body;
    if (score1 === null || score1 === undefined) {
      await pool.query('DELETE FROM results WHERE match_id = $1', [id]);
    } else {
      await pool.query(
        `INSERT INTO results (match_id, score1, score2) VALUES ($1,$2,$3)
         ON CONFLICT (match_id) DO UPDATE SET score1=$2, score2=$3`,
        [id, score1, score2]
      );
    }
    return res.json({ ok: true });
  }

  // ── GET /participants ───────────────────────────────────────────────────────
  if (url === '/participants' && method === 'GET') {
    const r = await pool.query('SELECT id, name FROM participants ORDER BY name');
    return res.json(r.rows);
  }

  // ── POST /participants ──────────────────────────────────────────────────────
  if (url === '/participants' && method === 'POST') {
    const adminPin = await getAdminPin();
    if (!requireAdmin(req, res, adminPin)) return;
    const { name, pin } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
    if (!pin || String(pin).length < 4) return res.status(400).json({ error: 'PIN deve ter pelo menos 4 dígitos' });
    const exists = await pool.query('SELECT id FROM participants WHERE LOWER(name)=LOWER($1)', [name]);
    if (exists.rows.length) return res.status(400).json({ error: 'Participante já existe' });
    const id = uuidv4();
    await pool.query('INSERT INTO participants (id,name,pin) VALUES ($1,$2,$3)', [id, name.trim(), String(pin)]);
    return res.json({ id, name: name.trim() });
  }

  // ── DELETE /participants/:id ────────────────────────────────────────────────
  const delPart = url.match(/^\/participants\/([^/]+)$/);
  if (delPart && method === 'DELETE') {
    const adminPin = await getAdminPin();
    if (!requireAdmin(req, res, adminPin)) return;
    const id = delPart[1];
    await pool.query('DELETE FROM bets WHERE participant_id=$1', [id]);
    await pool.query('DELETE FROM participants WHERE id=$1', [id]);
    return res.json({ ok: true });
  }

  // ── GET /bets ───────────────────────────────────────────────────────────────
  if (url === '/bets' && method === 'GET') {
    const r = await pool.query('SELECT id, participant_id as "participantId", match_id as "matchId", score1, score2 FROM bets');
    return res.json(r.rows);
  }

  // ── POST /bets ──────────────────────────────────────────────────────────────
  if (url === '/bets' && method === 'POST') {
    const { participantId, matchId, score1, score2 } = req.body;
    const pin = req.headers['x-participant-pin'];
    const p = await pool.query('SELECT pin FROM participants WHERE id=$1', [participantId]);
    if (!p.rows.length) return res.status(404).json({ error: 'Participante não encontrado' });
    if (p.rows[0].pin !== String(pin)) return res.status(401).json({ error: 'PIN incorreto' });
    const id = uuidv4();
    await pool.query(
      `INSERT INTO bets (id, participant_id, match_id, score1, score2) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (participant_id, match_id) DO UPDATE SET score1=$4, score2=$5, id=$1`,
      [id, participantId, String(matchId), score1, score2]
    );
    return res.json({ ok: true });
  }

  // ── GET /ranking ────────────────────────────────────────────────────────────
  if (url === '/ranking' && method === 'GET') {
    const parts   = await pool.query('SELECT id, name FROM participants ORDER BY name');
    const bets    = await pool.query('SELECT participant_id, match_id, score1, score2 FROM bets');
    const results = await pool.query('SELECT match_id, score1, score2 FROM results');
    const resMap  = {};
    results.rows.forEach(r => { resMap[r.match_id] = r; });

    const ranking = parts.rows.map(p => {
      const myBets = bets.rows.filter(b => b.participant_id === p.id);
      let points = 0, exact = 0, outcome = 0;
      myBets.forEach(b => {
        const res = resMap[b.match_id];
        const pts = res ? calcScore(b.score1, b.score2, res.score1, res.score2) : 0;
        points += pts;
        if (pts === 3) exact++;
        if (pts === 1) outcome++;
      });
      return { id: p.id, name: p.name, points, exact, outcome, betted: myBets.length };
    });
    ranking.sort((a, b) => b.points - a.points || b.exact - a.exact);
    return res.json(ranking);
  }

  // ── POST /auth/participant ──────────────────────────────────────────────────
  if (url === '/auth/participant' && method === 'POST') {
    const { participantId, pin } = req.body;
    const r = await pool.query('SELECT id, name, pin FROM participants WHERE id=$1', [participantId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Participante não encontrado' });
    if (r.rows[0].pin !== String(pin)) return res.status(401).json({ error: 'PIN incorreto' });
    return res.json({ ok: true, id: r.rows[0].id, name: r.rows[0].name });
  }

  // ── POST /auth/admin ────────────────────────────────────────────────────────
  if (url === '/auth/admin' && method === 'POST') {
    const { pin } = req.body;
    const adminPin = await getAdminPin();
    if (String(pin) !== adminPin) return res.status(401).json({ error: 'PIN incorreto' });
    return res.json({ ok: true });
  }

  // ── PUT /admin/pin ──────────────────────────────────────────────────────────
  if (url === '/admin/pin' && method === 'PUT') {
    const adminPin = await getAdminPin();
    if (!requireAdmin(req, res, adminPin)) return;
    const { newPin } = req.body;
    if (!newPin || String(newPin).length < 4) return res.status(400).json({ error: 'PIN deve ter pelo menos 4 dígitos' });
    await pool.query(`UPDATE config SET value=$1 WHERE key='admin_pin'`, [String(newPin)]);
    return res.json({ ok: true });
  }

  return res.status(404).json({ error: 'Rota não encontrada' });
};
