const express = require('express');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MATCHES_FILE = path.join(__dirname, 'data', 'matches.json');
const DB_FILE      = path.join(__dirname, 'data', 'db.json');

function loadMatches() {
  return JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf8'));
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { participants: [], bets: [], results: {}, admin_pin: '0000' };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db.admin_pin) db.admin_pin = '0000';
  return db;
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function calcScore(bet, result) {
  if (!result || result.score1 === null || result.score2 === null) return 0;
  const s1 = parseInt(result.score1), s2 = parseInt(result.score2);
  const b1 = parseInt(bet.score1),    b2 = parseInt(bet.score2);
  if (isNaN(b1) || isNaN(b2)) return 0;
  if (b1 === s1 && b2 === s2) return 3;
  const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;
  return sign(b1 - b2) === sign(s1 - s2) ? 1 : 0;
}

function requireAdmin(req, res, next) {
  const db  = loadDB();
  const pin = req.headers['x-admin-pin'];
  if (String(pin) !== String(db.admin_pin)) return res.status(401).json({ error: 'PIN de admin incorreto' });
  next();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/participant', (req, res) => {
  const { participantId, pin } = req.body;
  const db = loadDB();
  const p  = db.participants.find(x => x.id === participantId);
  if (!p)                    return res.status(404).json({ error: 'Participante não encontrado' });
  if (p.pin !== String(pin)) return res.status(401).json({ error: 'PIN incorreto' });
  res.json({ ok: true, id: p.id, name: p.name });
});

app.post('/api/auth/admin', (req, res) => {
  const { pin } = req.body;
  const db = loadDB();
  if (String(pin) !== String(db.admin_pin)) return res.status(401).json({ error: 'PIN incorreto' });
  res.json({ ok: true });
});

// ── Matches ───────────────────────────────────────────────────────────────────
app.get('/api/matches', (req, res) => {
  const data = loadMatches();
  const db   = loadDB();
  const matches = data.matches.map((m, i) => ({
    ...m,
    id: m.num !== undefined ? m.num : i,
    result: db.results[m.num !== undefined ? m.num : i] || null
  }));
  matches.sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return 0;
  });
  res.json(matches);
});

app.put('/api/matches/:id/result', requireAdmin, (req, res) => {
  const db = loadDB();
  db.results[req.params.id] = { score1: req.body.score1, score2: req.body.score2 };
  saveDB(db);
  res.json({ ok: true });
});

// ── Participants ──────────────────────────────────────────────────────────────
app.get('/api/participants', (req, res) => {
  const db = loadDB();
  res.json(db.participants.map(({ pin, ...p }) => p));
});

app.post('/api/participants', requireAdmin, (req, res) => {
  const db = loadDB();
  const { name, pin } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  if (!pin || String(pin).length < 4) return res.status(400).json({ error: 'PIN deve ter pelo menos 4 dígitos' });
  if (db.participants.find(p => p.name.toLowerCase() === name.toLowerCase()))
    return res.status(400).json({ error: 'Participante já existe' });
  const participant = { id: uuidv4(), name: name.trim(), pin: String(pin) };
  db.participants.push(participant);
  saveDB(db);
  res.json({ id: participant.id, name: participant.name });
});

app.delete('/api/participants/:id', requireAdmin, (req, res) => {
  const db = loadDB();
  db.participants = db.participants.filter(p => p.id !== req.params.id);
  db.bets         = db.bets.filter(b => b.participantId !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ── Bets ──────────────────────────────────────────────────────────────────────
app.get('/api/bets', (req, res) => {
  const db = loadDB();
  res.json(db.bets);
});

app.post('/api/bets', (req, res) => {
  const { participantId, matchId, score1, score2 } = req.body;
  const pin = req.headers['x-participant-pin'];
  const db  = loadDB();
  const p   = db.participants.find(x => x.id === participantId);
  if (!p)                    return res.status(404).json({ error: 'Participante não encontrado' });
  if (p.pin !== String(pin)) return res.status(401).json({ error: 'PIN incorreto' });
  if (matchId === undefined) return res.status(400).json({ error: 'Dados inválidos' });
  const idx = db.bets.findIndex(b => b.participantId === participantId && String(b.matchId) === String(matchId));
  const bet = { id: uuidv4(), participantId, matchId: String(matchId), score1, score2 };
  if (idx >= 0) db.bets[idx] = bet; else db.bets.push(bet);
  saveDB(db);
  res.json(bet);
});

// ── Ranking ───────────────────────────────────────────────────────────────────
app.get('/api/ranking', (req, res) => {
  const db   = loadDB();
  const ranking = db.participants.map(p => {
    let points = 0, exact = 0, outcome = 0;
    const bets = db.bets.filter(b => b.participantId === p.id);
    bets.forEach(b => {
      const pts = calcScore(b, db.results[b.matchId]);
      points += pts;
      if (pts === 3) exact++;
      if (pts === 1) outcome++;
    });
    return { id: p.id, name: p.name, points, exact, outcome, betted: bets.length };
  });
  ranking.sort((a, b) => b.points - a.points || b.exact - a.exact);
  res.json(ranking);
});

// ── Admin PIN ─────────────────────────────────────────────────────────────────
app.put('/api/admin/pin', requireAdmin, (req, res) => {
  const { newPin } = req.body;
  if (!newPin || String(newPin).length < 4) return res.status(400).json({ error: 'PIN deve ter pelo menos 4 dígitos' });
  const db = loadDB();
  db.admin_pin = String(newPin);
  saveDB(db);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bolão dos Sereios rodando em http://localhost:${PORT}`));
