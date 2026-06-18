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
      id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL,
      phone TEXT, cotas INTEGER NOT NULL DEFAULT 1, referred_by TEXT
    );
    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      match_id TEXT NOT NULL,
      score1 INTEGER, score2 INTEGER,
      cota_index INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(participant_id, match_id, cota_index)
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
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS cotas INTEGER NOT NULL DEFAULT 1;`)
    .catch(err => console.log('cotas col:', err.message));
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS referred_by TEXT;`)
    .catch(err => console.log('referred_by col:', err.message));
  await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT TRUE;`)
    .catch(err => console.log('approved col:', err.message));
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS cota_index INTEGER NOT NULL DEFAULT 0;`)
    .catch(err => console.log('cota_index col:', err.message));
  await pool.query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS penalties_winner TEXT;`)
    .catch(err => console.log('penalties_winner col:', err.message));
  
  try {
    await pool.query(`ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_participant_id_match_id_key;`);
  } catch (e) {
    console.log('unique constraint drop error:', e.message);
  }
  try {
    await pool.query(`ALTER TABLE bets ADD CONSTRAINT bets_participant_id_match_id_cota_index_key UNIQUE (participant_id, match_id, cota_index);`);
  } catch (e) {
    // Expected to fail if already exists
  }

  await pool.query(
    `INSERT INTO config (key, value) VALUES ('admin_pin', '2504') ON CONFLICT (key) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO config (key, value) VALUES ('valor_cota', '25') ON CONFLICT (key) DO NOTHING`
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

async function wouldCreateCycle(pool, participantId, referrerId) {
  if (!referrerId) return false;
  if (participantId === referrerId) return true;
  
  let currentId = referrerId;
  const visited = new Set();
  visited.add(participantId);
  
  while (currentId) {
    if (visited.has(currentId)) {
      return true;
    }
    visited.add(currentId);
    const res = await pool.query('SELECT referred_by FROM participants WHERE id = $1', [currentId]);
    currentId = res.rows[0]?.referred_by || null;
  }
  return false;
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
      const { rows } = await pool.query('SELECT match_id, score1, score2, penalties_winner FROM results');
      const resMap = {};
      rows.forEach(r => { resMap[r.match_id] = { score1: r.score1, score2: r.score2, penalties_winner: r.penalties_winner }; });
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
      const { score1, score2, penalties_winner } = body;
      if (score1 === null || score1 === undefined) {
        await pool.query('DELETE FROM results WHERE match_id=$1', [id]);
        const matches = loadMatches();
        const m = matches.find(x => String(x.id) === String(id));
        if (m && (String(m.id) === '104' || m.round === 'Final')) {
          await pool.query("DELETE FROM config WHERE key='champion'");
        }
      } else {
        await pool.query(
          `INSERT INTO results (match_id,score1,score2,penalties_winner) VALUES ($1,$2,$3,$4)
           ON CONFLICT (match_id) DO UPDATE SET score1=$2,score2=$3,penalties_winner=$4`,
          [id, score1, score2, penalties_winner || null]
        );
        const matches = loadMatches();
        const m = matches.find(x => String(x.id) === String(id));
        if (m && (String(m.id) === '104' || m.round === 'Final')) {
          let champion = null;
          if (score1 > score2) champion = m.team1;
          else if (score2 > score1) champion = m.team2;
          else champion = penalties_winner;
          
          if (champion) {
            await pool.query(
              `INSERT INTO config (key, value) VALUES ('champion', $1)
               ON CONFLICT (key) DO UPDATE SET value=$1`,
              [champion]
            );
          } else {
            await pool.query("DELETE FROM config WHERE key='champion'");
          }
        }
      }
      return res.status(200).json({ ok: true });
    }

    // GET /participants
    if (url === '/participants' && method === 'GET') {
      const { rows } = await pool.query('SELECT id, name, phone, cotas, referred_by FROM participants WHERE approved = TRUE ORDER BY name');
      return res.status(200).json(rows);
    }

    // GET /participants/pending
    if (url === '/participants/pending' && method === 'GET') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { rows } = await pool.query('SELECT id, name, phone, referred_by, approved FROM participants WHERE approved = FALSE ORDER BY name');
      return res.status(200).json(rows);
    }

    // POST /participants/request (Public referral request)
    if (url === '/participants/request' && method === 'POST') {
      const { name, pin, phone, referred_by } = body;
      if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
      if (!pin || String(pin).length < 4) return res.status(400).json({ error: 'PIN deve ter pelo menos 4 dígitos' });
      const exists = await pool.query('SELECT id FROM participants WHERE LOWER(name)=LOWER($1)', [name]);
      if (exists.rows.length) return res.status(400).json({ error: 'Participante já existe' });
      const id = uuidv4();
      const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
      
      // Inserts with approved=FALSE
      await pool.query('INSERT INTO participants (id,name,pin,phone,cotas,referred_by,approved) VALUES ($1,$2,$3,$4,1,$5,FALSE)', 
        [id, name.trim(), String(pin), cleanPhone || null, referred_by || null]);
      return res.status(200).json({ id, name: name.trim(), referred_by });
    }

    // PUT /participants/:id/approve
    const approvePart = url.match(/^\/participants\/([^/]+)\/approve$/);
    if (approvePart && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const id = approvePart[1];
      await pool.query('UPDATE participants SET approved = TRUE WHERE id = $1', [id]);
      return res.status(200).json({ ok: true });
    }

    // POST /participants
    if (url === '/participants' && method === 'POST') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { name, pin, phone, cotas, referred_by } = body;
      if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
      if (!pin || String(pin).length < 4) return res.status(400).json({ error: 'PIN deve ter pelo menos 4 dígitos' });
      const exists = await pool.query('SELECT id FROM participants WHERE LOWER(name)=LOWER($1)', [name]);
      if (exists.rows.length) return res.status(400).json({ error: 'Participante já existe' });
      const id = uuidv4();
      const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
      let cotasVal = parseInt(cotas !== undefined ? cotas : 1);
      if (isNaN(cotasVal) || cotasVal < 0) cotasVal = 1;
      await pool.query('INSERT INTO participants (id,name,pin,phone,cotas,referred_by,approved) VALUES ($1,$2,$3,$4,$5,$6,TRUE)', [id, name.trim(), String(pin), cleanPhone || null, cotasVal, referred_by || null]);
      return res.status(200).json({ id, name: name.trim(), cotas: cotasVal, referred_by });
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

    // PUT /participants/:id  (update name, phone, optionally pin/cotas/referred_by)
    if (delPart && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const id = delPart[1];
      const { name, pin, phone, cotas, referred_by } = body;
      if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
      const dup = await pool.query('SELECT id FROM participants WHERE LOWER(name)=LOWER($1) AND id!=$2', [name, id]);
      if (dup.rows.length) return res.status(400).json({ error: 'Nome já existe' });
      const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
      let cotasVal = cotas !== undefined ? parseInt(cotas) : null;
      if (cotasVal !== null && (isNaN(cotasVal) || cotasVal < 0)) cotasVal = 1;
      
      if (referred_by) {
        const isCycle = await wouldCreateCycle(pool, id, referred_by);
        if (isCycle) return res.status(400).json({ error: 'Indicação inválida: cria uma indicação cruzada ou circular' });
      }
      
      if (pin && String(pin).length >= 4) {
        if (cotasVal !== null) {
          await pool.query('UPDATE participants SET name=$1, phone=$2, pin=$3, cotas=$4, referred_by=$5 WHERE id=$6',
            [name.trim(), cleanPhone || null, String(pin), cotasVal, referred_by || null, id]);
        } else {
          await pool.query('UPDATE participants SET name=$1, phone=$2, pin=$3, referred_by=$4 WHERE id=$5',
            [name.trim(), cleanPhone || null, String(pin), referred_by || null, id]);
        }
      } else {
        if (cotasVal !== null) {
          await pool.query('UPDATE participants SET name=$1, phone=$2, cotas=$3, referred_by=$4 WHERE id=$5',
            [name.trim(), cleanPhone || null, cotasVal, referred_by || null, id]);
        } else {
          await pool.query('UPDATE participants SET name=$1, phone=$2, referred_by=$3 WHERE id=$4',
            [name.trim(), cleanPhone || null, referred_by || null, id]);
        }
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
        const pCheck = await pool.query('SELECT pin, approved FROM participants WHERE id=$1', [pId]);
        if (pCheck.rows.length && pCheck.rows[0].pin === String(pPin) && pCheck.rows[0].approved !== false) {
          pValid = true;
        }
      }

      const { rows } = await pool.query(
        'SELECT id, participant_id as "participantId", match_id as "matchId", score1, score2, cota_index as "cotaIndex", created_at as "createdAt" FROM bets'
      );
      
      const maskedRows = rows.map(r => {
        if (isAdmin || (pValid && r.participantId === pId)) {
          return r;
        } else {
          return {
            id: r.id,
            participantId: r.participantId,
            matchId: r.matchId,
            cotaIndex: r.cotaIndex,
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
      const { participantId, matchId, score1, score2, cotaIndex } = body;
      const pin = req.headers['x-participant-pin'];
      const p = await pool.query('SELECT pin, cotas, approved FROM participants WHERE id=$1', [participantId]);
      if (!p.rows.length) return res.status(404).json({ error: 'Participante não encontrado' });
      if (p.rows[0].approved === false) return res.status(403).json({ error: 'Sua conta ainda não foi aprovada pelo administrador' });
      if (p.rows[0].pin !== String(pin)) return res.status(401).json({ error: 'PIN incorreto' });

      const maxCotas = p.rows[0].cotas;
      const idx = parseInt(cotaIndex !== undefined ? cotaIndex : 0);
      if (idx < 0 || idx >= maxCotas) {
        return res.status(400).json({ error: 'Índice de cota inválido para este participante' });
      }

      // Block bets once the match has started
      const match = loadMatches().find(m => m.id === String(matchId));
      if (match && isLocked(match)) {
        return res.status(403).json({ error: 'Os palpites para este jogo já foram encerrados' });
      }

      const id = uuidv4();
      await pool.query(
        `INSERT INTO bets (id,participant_id,match_id,score1,score2,cota_index,created_at) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
         ON CONFLICT (participant_id,match_id,cota_index) DO UPDATE SET score1=$4,score2=$5,id=$1,created_at=CURRENT_TIMESTAMP`,
        [id, participantId, String(matchId), score1, score2, idx]
      );
      return res.status(200).json({ ok: true });
    }

    // GET /ranking
    if (url === '/ranking' && method === 'GET') {
      const parts   = await pool.query('SELECT id, name, cotas FROM participants WHERE approved=TRUE ORDER BY name');
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
        return { id: p.id, name: p.name, cotas: p.cotas, points, exact, outcome, betted: myBets.length };
      });
      ranking.sort((a, b) => b.points - a.points || b.exact - a.exact);
      return res.status(200).json(ranking);
    }

    // POST /auth/participant
    if (url === '/auth/participant' && method === 'POST') {
      const { participantId, pin } = body;
      const r = await pool.query('SELECT id, name, pin, cotas, approved FROM participants WHERE id=$1', [participantId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Participante não encontrado' });
      if (r.rows[0].approved === false) return res.status(403).json({ error: 'Sua conta ainda não foi aprovada pelo administrador' });
      if (r.rows[0].pin !== String(pin)) return res.status(401).json({ error: 'PIN incorreto' });
      return res.status(200).json({ ok: true, id: r.rows[0].id, name: r.rows[0].name, cotas: r.rows[0].cotas });
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

    // GET /config/arrecadado (Dynamically calculated based on user cotas sum * valor_cota)
    if (url === '/config/arrecadado' && method === 'GET') {
      const sumRes = await pool.query('SELECT SUM(cotas) as total_cotas FROM participants WHERE approved = TRUE');
      const totalCotas = parseInt(sumRes.rows[0]?.total_cotas || 0);

      const cotaRes = await pool.query(`SELECT value FROM config WHERE key = 'valor_cota'`);
      const valorCota = parseFloat(cotaRes.rows[0]?.value || '25');

      const val = totalCotas * valorCota;
      return res.status(200).json({ value: String(val) });
    }

    // GET /config/valor_cota
    if (url === '/config/valor_cota' && method === 'GET') {
      const cotaRes = await pool.query(`SELECT value FROM config WHERE key = 'valor_cota'`);
      const valorCota = parseFloat(cotaRes.rows[0]?.value || '25');
      return res.status(200).json({ value: String(valorCota) });
    }

    // PUT /config/arrecadado (Actually updates the valor_cota option)
    if (url === '/config/arrecadado' && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { value } = body;
      const parsedValue = parseFloat(value) || 0;
      await pool.query(
        `INSERT INTO config (key, value) VALUES ('valor_cota', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1`,
        [String(parsedValue)]
      );
      return res.status(200).json({ ok: true });
    }

    // GET /config/champion
    if (url === '/config/champion' && method === 'GET') {
      const r = await pool.query(`SELECT value FROM config WHERE key = 'champion'`);
      const val = r.rows[0]?.value || '';
      return res.status(200).json({ value: val });
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

      if (String(value) === 'true') {
        const matches = loadMatches();
        const finalMatch = matches.find(m => String(m.id) === '104' || m.round === 'Final');
        if (finalMatch) {
          const resQuery = await pool.query('SELECT score1, score2, penalties_winner FROM results WHERE match_id=$1', [finalMatch.id]);
          if (resQuery.rows.length) {
            const { score1, score2, penalties_winner } = resQuery.rows[0];
            let champion = null;
            if (score1 > score2) champion = finalMatch.team1;
            else if (score2 > score1) champion = finalMatch.team2;
            else champion = penalties_winner;

            if (champion) {
              await pool.query(
                `INSERT INTO config (key, value) VALUES ('champion', $1)
                 ON CONFLICT (key) DO UPDATE SET value=$1`,
                [champion]
              );
            }
          }
        }
      }
      return res.status(200).json({ ok: true });
    }


    return res.status(404).json({ error: 'Rota não encontrada: ' + url });

  } catch (e) {
    console.error('handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
