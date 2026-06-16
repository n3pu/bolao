const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const nodePath = require('path');
const fs = require('fs');

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');


const pool = new Pool({
  connectionString: dbUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});


async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      match_id TEXT NOT NULL,
      score1 INTEGER, score2 INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(participant_id, match_id)
    );
    CREATE TABLE IF NOT EXISTS results (
      match_id TEXT PRIMARY KEY, score1 INTEGER, score2 INTEGER
    );
  `);
  // Ensure columns exist for older deployments
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`)
    .catch(err => console.log('created_at col:', err.message));
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS phone TEXT;`)
    .catch(err => console.log('phone col:', err.message));
  await pool.query(
    `INSERT INTO config (key, value) VALUES ('admin_pin', '2504') ON CONFLICT (key) DO NOTHING`
  );
}

function loadMatches() {
  const data = JSON.parse(fs.readFileSync(nodePath.join(__dirname, '..', 'matches.json'), 'utf8'));
  return data.matches
    .map((m, i) => ({ ...m, id: String(m.num !== undefined ? m.num : i) }))
    .sort((a, b) => (a.date || '') < (b.date || '') ? -1 : 1);
}

function isLocked(match) {
  if (!match.datetime) return false;
  return new Date() >= new Date(match.datetime);
}

function calcScore(b1, b2, s1, s2) {
  if (s1 === null || s2 === null) return 0;
  b1 = parseInt(b1); b2 = parseInt(b2);
  s1 = parseInt(s1); s2 = parseInt(s2);
  if (isNaN(b1) || isNaN(b2)) return 0;
  if (b1 === s1 && b2 === s2) return 3;
  const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;
  return sign(b1 - b2) === sign(s1 - s2) ? 1 : 0;
}

async function getAdminPin() {
  const r = await pool.query(`SELECT value FROM config WHERE key = 'admin_pin'`);
  return r.rows[0]?.value || '0000';
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function getPath(req) {
  // vercel rewrite passes path as query param: /api/index.js?path=participants
  // or path might be like "matches/5/result"
  const qs = req.url.split('?')[1] || '';
  const params = new URLSearchParams(qs);
  const p = params.get('path') || '';
  return '/' + p;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-pin,x-participant-pin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try { await initDB(); } catch (e) {
    console.error('initDB error:', e.message);
    return res.status(500).json({ error: 'DB error: ' + e.message });
  }

  const body = await parseBody(req);
  // with @vercel/node routes, req.url is the original path e.g. /api/participants
  const url = (req.url || "").replace(/^\/api/, "").replace(/\?.*/,"");
  const method = req.method;

  console.log(method, url);

  try {

    // GET /countries
    if (url === '/countries' && method === 'GET') {
      try {
        const countries = JSON.parse(fs.readFileSync(nodePath.join(__dirname, '..', 'data', 'countries.json'), 'utf8'));
        return res.status(200).json(countries);
      } catch (e) {
        return res.status(500).json({ error: 'Erro ao carregar países: ' + e.message });
      }
    }

    // GET /matches
    if (url === '/matches' && method === 'GET') {
      const matches = loadMatches();
      const { rows } = await pool.query('SELECT match_id, score1, score2 FROM results');
      const resMap = {};
      rows.forEach(r => { resMap[r.match_id] = { score1: r.score1, score2: r.score2 }; });
      return res.status(200).json(matches.map(m => ({
        ...m,
        result: resMap[m.id] || null,
        locked: isLocked(m)
      })));
    }

    // PUT /matches/:id/result
    const matchResult = url.match(/^\/matches\/([^/]+)\/result$/);
    if (matchResult && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const id = matchResult[1];
      const { score1, score2 } = body;
      if (score1 === null || score1 === undefined) {
        await pool.query('DELETE FROM results WHERE match_id=$1', [id]);
      } else {
        await pool.query(
          `INSERT INTO results (match_id,score1,score2) VALUES ($1,$2,$3)
           ON CONFLICT (match_id) DO UPDATE SET score1=$2,score2=$3`,
          [id, score1, score2]
        );
      }
      return res.status(200).json({ ok: true });
    }

    // GET /participants
    if (url === '/participants' && method === 'GET') {
      const { rows } = await pool.query('SELECT id, name, phone FROM participants ORDER BY name');
      return res.status(200).json(rows);
    }

    // POST /participants
    if (url === '/participants' && method === 'POST') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { name, pin, phone } = body;
      if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
      if (!pin || String(pin).length < 4) return res.status(400).json({ error: 'PIN deve ter pelo menos 4 dígitos' });
      const exists = await pool.query('SELECT id FROM participants WHERE LOWER(name)=LOWER($1)', [name]);
      if (exists.rows.length) return res.status(400).json({ error: 'Participante já existe' });
      const id = uuidv4();
      const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
      await pool.query('INSERT INTO participants (id,name,pin,phone) VALUES ($1,$2,$3,$4)', [id, name.trim(), String(pin), cleanPhone || null]);
      return res.status(200).json({ id, name: name.trim() });
    }

    // DELETE /participants/:id
    const delPart = url.match(/^\/participants\/([^/]+)$/);
    if (delPart && method === 'DELETE') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      await pool.query('DELETE FROM bets WHERE participant_id=$1', [delPart[1]]);
      await pool.query('DELETE FROM participants WHERE id=$1', [delPart[1]]);
      return res.status(200).json({ ok: true });
    }

    // PUT /participants/:id  (update name, phone, optionally pin)
    if (delPart && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const id = delPart[1];
      const { name, pin, phone } = body;
      if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
      const dup = await pool.query('SELECT id FROM participants WHERE LOWER(name)=LOWER($1) AND id!=$2', [name, id]);
      if (dup.rows.length) return res.status(400).json({ error: 'Nome já existe' });
      const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
      if (pin && String(pin).length >= 4) {
        await pool.query('UPDATE participants SET name=$1, phone=$2, pin=$3 WHERE id=$4',
          [name.trim(), cleanPhone || null, String(pin), id]);
      } else {
        await pool.query('UPDATE participants SET name=$1, phone=$2 WHERE id=$3',
          [name.trim(), cleanPhone || null, id]);
      }
      return res.status(200).json({ ok: true });
    }

    // PUT /participants/:id/pin
    const putPartPin = url.match(/^\/participants\/([^/]+)\/pin$/);
    if (putPartPin && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const id = putPartPin[1];
      const { pin } = body;
      if (!pin || String(pin).length < 4) return res.status(400).json({ error: 'PIN deve ter pelo menos 4 dígitos' });
      await pool.query('UPDATE participants SET pin=$1 WHERE id=$2', [String(pin), id]);
      return res.status(200).json({ ok: true });
    }

    // PUT /participants/:id/phone
    const putPartPhone = url.match(/^\/participants\/([^/]+)\/phone$/);
    if (putPartPhone && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const id = putPartPhone[1];
      const { phone } = body;
      const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
      await pool.query('UPDATE participants SET phone=$1 WHERE id=$2', [cleanPhone || null, id]);
      return res.status(200).json({ ok: true });
    }

    // GET /bets
    if (url === '/bets' && method === 'GET') {
      const adminPin = await getAdminPin();
      const isAdmin = String(req.headers['x-admin-pin']) === adminPin;
      
      const pId = req.headers['x-participant-id'];
      const pPin = req.headers['x-participant-pin'];
      
      let pValid = false;
      if (pId && pPin) {
        const pCheck = await pool.query('SELECT pin FROM participants WHERE id=$1', [pId]);
        if (pCheck.rows.length && pCheck.rows[0].pin === String(pPin)) {
          pValid = true;
        }
      }

      const { rows } = await pool.query(
        'SELECT id, participant_id as "participantId", match_id as "matchId", score1, score2, created_at as "createdAt" FROM bets'
      );
      
      const maskedRows = rows.map(r => {
        if (isAdmin || (pValid && r.participantId === pId)) {
          return r;
        } else {
          return {
            id: r.id,
            participantId: r.participantId,
            matchId: r.matchId,
            score1: null,
            score2: null,
            createdAt: r.createdAt
          };
        }
      });
      
      return res.status(200).json(maskedRows);
    }

    // POST /bets
    if (url === '/bets' && method === 'POST') {
      const { participantId, matchId, score1, score2 } = body;
      const pin = req.headers['x-participant-pin'];
      const p = await pool.query('SELECT pin FROM participants WHERE id=$1', [participantId]);
      if (!p.rows.length) return res.status(404).json({ error: 'Participante não encontrado' });
      if (p.rows[0].pin !== String(pin)) return res.status(401).json({ error: 'PIN incorreto' });

      // Block bets once the match has started
      const match = loadMatches().find(m => m.id === String(matchId));
      if (match && isLocked(match)) {
        return res.status(403).json({ error: 'As apostas para este jogo já foram encerradas' });
      }

      const id = uuidv4();
      await pool.query(
        `INSERT INTO bets (id,participant_id,match_id,score1,score2,created_at) VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
         ON CONFLICT (participant_id,match_id) DO UPDATE SET score1=$4,score2=$5,id=$1,created_at=CURRENT_TIMESTAMP`,
        [id, participantId, String(matchId), score1, score2]
      );
      return res.status(200).json({ ok: true });
    }

    // GET /ranking
    if (url === '/ranking' && method === 'GET') {
      const parts   = await pool.query('SELECT id, name FROM participants ORDER BY name');
      const bets    = await pool.query('SELECT participant_id, match_id, score1, score2 FROM bets');
      const results = await pool.query('SELECT match_id, score1, score2 FROM results');
      const resMap  = {};
      results.rows.forEach(r => { resMap[r.match_id] = r; });
      const ranking = parts.rows.map(p => {
        // Only count bets for matches on or after Brazil's first game (2026-06-20T01:00:00Z)
        const myBets = bets.rows.filter(b => {
          if (b.participant_id !== p.id) return false;
          const m = loadMatches().find(x => String(x.id) === String(b.match_id));
          return m && m.datetime >= '2026-06-20T01:00:00Z';
        });
        let points = 0, exact = 0, outcome = 0;
        myBets.forEach(b => {
          const r = resMap[b.match_id];
          const pts = r ? calcScore(b.score1, b.score2, r.score1, r.score2) : 0;
          points += pts; if (pts === 3) exact++; if (pts === 1) outcome++;
        });
        return { id: p.id, name: p.name, points, exact, outcome, betted: myBets.length };
      });
      ranking.sort((a, b) => b.points - a.points || b.exact - a.exact);
      return res.status(200).json(ranking);
    }

    // POST /auth/participant
    if (url === '/auth/participant' && method === 'POST') {
      const { participantId, pin } = body;
      const r = await pool.query('SELECT id, name, pin FROM participants WHERE id=$1', [participantId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Participante não encontrado' });
      if (r.rows[0].pin !== String(pin)) return res.status(401).json({ error: 'PIN incorreto' });
      return res.status(200).json({ ok: true, id: r.rows[0].id, name: r.rows[0].name });
    }

    // POST /auth/admin
    if (url === '/auth/admin' && method === 'POST') {
      const { pin } = body;
      const adminPin = await getAdminPin();
      if (String(pin) !== adminPin) return res.status(401).json({ error: 'PIN incorreto' });
      return res.status(200).json({ ok: true });
    }

    // PUT /admin/pin
    if (url === '/admin/pin' && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { newPin } = body;
      if (!newPin || String(newPin).length < 4) return res.status(400).json({ error: 'PIN deve ter pelo menos 4 dígitos' });
      await pool.query(`UPDATE config SET value=$1 WHERE key='admin_pin'`, [String(newPin)]);
      return res.status(200).json({ ok: true });
    }

    // GET /config/arrecadado
    if (url === '/config/arrecadado' && method === 'GET') {
      const r = await pool.query(`SELECT value FROM config WHERE key = 'arrecadado'`);
      const val = r.rows[0]?.value || '0';
      return res.status(200).json({ value: val });
    }

    // PUT /config/arrecadado
    if (url === '/config/arrecadado' && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { value } = body;
      const parsedValue = parseFloat(value) || 0;
      await pool.query(
        `INSERT INTO config (key, value) VALUES ('arrecadado', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1`,
        [String(parsedValue)]
      );
      return res.status(200).json({ ok: true });
    }

    // GET /config/cup_finished
    if (url === '/config/cup_finished' && method === 'GET') {
      const r = await pool.query(`SELECT value FROM config WHERE key = 'cup_finished'`);
      const val = r.rows[0]?.value || 'false';
      return res.status(200).json({ value: val });
    }

    // PUT /config/cup_finished
    if (url === '/config/cup_finished' && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { value } = body;
      await pool.query(
        `INSERT INTO config (key, value) VALUES ('cup_finished', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1`,
        [String(value)]
      );
      return res.status(200).json({ ok: true });
    }


    return res.status(404).json({ error: 'Rota não encontrada: ' + url });

  } catch (e) {
    console.error('handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
