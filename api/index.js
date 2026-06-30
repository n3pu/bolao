const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const nodePath = require('path');
const fs = require('fs');
const webpush = require('web-push');

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(
    'mailto:contato@bolao.unk',
    vapidPublicKey,
    vapidPrivateKey
  );
} else {
  console.warn('VAPID keys not configured in environment variables.');
}

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');


const pool = new Pool({
  connectionString: dbUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});


let initDBPromise = null;

async function initDB() {
  if (initDBPromise) return initDBPromise;

  initDBPromise = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS participants (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL,
          phone TEXT, cotas INTEGER NOT NULL DEFAULT 1, referred_by TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
          match_id TEXT PRIMARY KEY, score1 INTEGER, score2 INTEGER, status TEXT DEFAULT 'finished'
        );
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id TEXT PRIMARY KEY,
          participant_id TEXT,
          endpoint TEXT UNIQUE NOT NULL,
          keys_auth TEXT NOT NULL,
          keys_p256dh TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS banners (
          id TEXT PRIMARY KEY,
          message TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'warning',
          active BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS comm_log (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          sub_type TEXT,
          message TEXT NOT NULL,
          detail TEXT,
          recipient_count INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS wallets (
          participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
          balance NUMERIC(10,2) NOT NULL DEFAULT 0.00,
          total_deposited NUMERIC(10,2) NOT NULL DEFAULT 0.00,
          total_used NUMERIC(10,2) NOT NULL DEFAULT 0.00,
          total_won NUMERIC(10,2) NOT NULL DEFAULT 0.00,
          total_withdrawn NUMERIC(10,2) NOT NULL DEFAULT 0.00
        );
        CREATE TABLE IF NOT EXISTS wallet_deposits (
          id TEXT PRIMARY KEY,
          participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          amount NUMERIC(10,2) NOT NULL,
          receipt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS wallet_transactions (
          id TEXT PRIMARY KEY,
          participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          amount NUMERIC(10,2) NOT NULL,
          type TEXT NOT NULL,
          description TEXT NOT NULL,
          reference_id TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS challenge_matches (
          match_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'open',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS challenge_entries (
          id TEXT PRIMARY KEY,
          participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          match_id TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(participant_id, match_id)
        );
        CREATE TABLE IF NOT EXISTS challenge_predictions (
          entry_id TEXT PRIMARY KEY REFERENCES challenge_entries(id) ON DELETE CASCADE,
          score1 INTEGER NOT NULL,
          score2 INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS challenge_results (
          match_id TEXT PRIMARY KEY REFERENCES challenge_matches(match_id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'finished',
          processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS challenge_prize_distributions (
          id TEXT PRIMARY KEY,
          match_id TEXT NOT NULL,
          participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
          amount NUMERIC(10,2) NOT NULL,
          type TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      await pool.query(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`)
        .catch(err => console.log('created_at col in participants:', err.message));
      await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS cota_index INTEGER NOT NULL DEFAULT 0;`)
        .catch(err => console.log('cota_index col:', err.message));
      await pool.query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS penalties_winner TEXT;`)
        .catch(err => console.log('penalties_winner col:', err.message));
      await pool.query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'finished';`)
        .catch(err => console.log('status col:', err.message));
      await pool.query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS live_link TEXT;`)
        .catch(err => console.log('live_link col:', err.message));
      await pool.query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS match_datetime TEXT;`)
        .catch(err => console.log('match_datetime col:', err.message));
      await pool.query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS manual_override BOOLEAN DEFAULT FALSE;`)
        .catch(err => console.log('manual_override col:', err.message));
      await pool.query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS team1 TEXT;`)
        .catch(err => console.log('team1 col:', err.message));
      await pool.query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS team2 TEXT;`)
        .catch(err => console.log('team2 col:', err.message));
      await pool.query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS team1_badge TEXT;`)
        .catch(err => console.log('team1_badge col:', err.message));
      await pool.query(`ALTER TABLE results ADD COLUMN IF NOT EXISTS team2_badge TEXT;`)
        .catch(err => console.log('team2_badge col:', err.message));
      
      await pool.query(`
        CREATE TABLE IF NOT EXISTS api_match_mappings (
          local_match_id TEXT PRIMARY KEY,
          api_match_id TEXT UNIQUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `).catch(err => console.log('api_match_mappings table:', err.message));

      await pool.query(`
        CREATE TABLE IF NOT EXISTS sync_logs (
          id TEXT PRIMARY KEY,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          status TEXT NOT NULL,
          matches_synced INTEGER NOT NULL DEFAULT 0,
          details TEXT
        );
      `).catch(err => console.log('sync_logs table:', err.message));

      // Check if we were previously using TheSportsDB
      try {
        const prevSportsDb = await pool.query("SELECT * FROM config WHERE key = 'thesportsdb_api_last_sync'");
        if (prevSportsDb.rows.length > 0) {
          console.log('Migrating back to Football-Data: Clearing api_match_mappings and old configs...');
          await pool.query("DELETE FROM api_match_mappings");
          await pool.query("DELETE FROM config WHERE key = 'thesportsdb_api_last_sync'");
          await pool.query("DELETE FROM config WHERE key = 'thesportsdb_api_last_success'");
        }
      } catch (migrationErr) {
        console.log('Migration cleanup error:', migrationErr.message);
      }

      await pool.query(`ALTER TABLE banners ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'warning';`)
        .catch(err => console.log('banner type col:', err.message));
      
      // Auto-cleanup comm_log older than 10 days
      await pool.query(`DELETE FROM comm_log WHERE created_at < NOW() - INTERVAL '10 days';`)
        .catch(err => console.log('comm_log cleanup:', err.message));
      
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
      await pool.query(
        `INSERT INTO config (key, value) VALUES ('countdown', '{"title":"","body":"","target":"","active":false}') ON CONFLICT (key) DO NOTHING`
      );
    } catch (err) {
      initDBPromise = null; // reset so next request can retry
      throw err;
    }
  })();

  return initDBPromise;
}

function loadMatches() {
  const data = JSON.parse(fs.readFileSync(nodePath.join(__dirname, '..', 'matches.json'), 'utf8'));
  return data.matches
    .map((m, i) => ({ ...m, id: String(m.num !== undefined ? m.num : i) }))
    .sort((a, b) => (a.date || '') < (b.date || '') ? -1 : 1);
}

function isLocked(match) {
  if (match.result && (match.result.status === 'live' || match.result.status === 'in_play' || match.result.status === 'finished')) {
    return true;
  }
  if (!match.datetime) return false;
  return new Date() >= new Date(match.datetime);
}

function translateTeamNameLocal(apiName, localMatch = null) {
  if (!apiName) return '';
  const clean = apiName.trim().toLowerCase();
  
  // Synonyms/Translations map from TheSportsDB name -> matches.json key name
  const mapping = {
    'united states': 'USA',
    'united states of america': 'USA',
    'usa': 'USA',
    'korea republic': 'South Korea',
    'south korea': 'South Korea',
    'czechia': 'Czech Republic',
    'czech republic': 'Czech Republic',
    'côte d\'ivoire': 'Ivory Coast',
    'cote d\'ivoire': 'Ivory Coast',
    'ivory coast': 'Ivory Coast',
    'congo dr': 'DR Congo',
    'dr congo': 'DR Congo',
    'cabo verde': 'Cape Verde',
    'cape verde': 'Cape Verde',
    'bosnia and herzegovina': 'Bosnia & Herzegovina',
    'bosnia & herzegovina': 'Bosnia & Herzegovina',
    'bosnia-herzegovina': 'Bosnia & Herzegovina',
    'macedonia': 'North Macedonia',
    'republic of Ireland': 'Ireland'
  };

  // Check direct mapping
  for (const [key, val] of Object.entries(mapping)) {
    if (clean === key) return val;
  }

  // Fallback: check if matches.json uses this name
  const localCountries = [
    'Algeria', 'Argentina', 'Australia', 'Austria', 'Belgium', 'Bosnia & Herzegovina', 
    'Brazil', 'Canada', 'Cape Verde', 'Colombia', 'Croatia', 'Curaçao', 'Czech Republic', 
    'DR Congo', 'Ecuador', 'Egypt', 'England', 'France', 'Germany', 'Ghana', 'Haiti', 
    'Iran', 'Iraq', 'Ivory Coast', 'Japan', 'Jordan', 'Mexico', 'Morocco', 'Netherlands', 
    'New Zealand', 'Norway', 'Panama', 'Paraguay', 'Portugal', 'Qatar', 'Saudi Arabia', 
    'Scotland', 'Senegal', 'South Africa', 'South Korea', 'Spain', 'Sweden', 'Switzerland', 
    'Tunisia', 'Turkey', 'USA', 'Uruguay', 'Uzbekistan'
  ];

  const found = localCountries.find(c => c.toLowerCase() === clean);
  if (found) return found;

  return apiName;
}

function findBestLocalMatch(apiMatch, localMatches, mappingMap, resultsMap = {}) {
  const apiId = String(apiMatch.id);
  const mappedLocalIds = new Set(Object.values(mappingMap));

  const apiHome = translateTeamNameLocal(apiMatch.homeTeam ? apiMatch.homeTeam.name : '').toLowerCase();
  const apiAway = translateTeamNameLocal(apiMatch.awayTeam ? apiMatch.awayTeam.name : '').toLowerCase();

  // 1. Group Stage: Find by team names in either order inside a group match
  if (apiMatch.stage === 'GROUP_STAGE') {
    const groupMatch = localMatches.find(m => {
      if (mappedLocalIds.has(m.id)) return false;
      if (!m.group) return false; // Must be group stage in local template

      const mHome = m.team1.toLowerCase();
      const mAway = m.team2.toLowerCase();
      return (mHome === apiHome && mAway === apiAway) || (mHome === apiAway && mAway === apiHome);
    });

    if (groupMatch) return groupMatch.id;
  }

  // 2. Knockout Stage: Find by resolved team names first
  if (apiHome && apiAway && apiHome !== 'tbd' && apiAway !== 'tbd' && !apiHome.startsWith('1') && !apiHome.startsWith('2') && !apiAway.startsWith('1') && !apiAway.startsWith('2')) {
    const resolvedMatch = localMatches.find(m => {
      if (mappedLocalIds.has(m.id)) return false;
      if (m.group) return false; // Must be knockout stage

      const r = resultsMap[m.id];
      const localHome = (r && r.team1 ? r.team1 : m.team1).toLowerCase();
      const localAway = (r && r.team2 ? r.team2 : m.team2).toLowerCase();

      return (localHome === apiHome && localAway === apiAway) || (localHome === apiAway && localAway === apiHome);
    });

    if (resolvedMatch) return resolvedMatch.id;
  }

  // Fallback to stage/round name and date
  let targetRound = '';
  const apiStage = String(apiMatch.stage || '').toUpperCase();

  if (apiStage === 'LAST_32' || apiStage === 'ROUND_OF_32') {
    targetRound = 'Round of 32';
  } else if (apiStage === 'LAST_16' || apiStage === 'ROUND_OF_16') {
    targetRound = 'Round of 16';
  } else if (apiStage === 'QUARTER_FINALS') {
    targetRound = 'Quarter-final';
  } else if (apiStage === 'SEMI_FINALS') {
    targetRound = 'Semi-final';
  } else if (apiStage === 'THIRD_PLACE') {
    targetRound = 'Third place';
  } else if (apiStage === 'FINAL') {
    targetRound = 'Final';
  }

  if (!targetRound) return null;

  // Filter local matches of this round that are not already mapped
  const candidates = localMatches.filter(m => {
    if (mappedLocalIds.has(m.id)) return false;
    return m.round === targetRound;
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;

  // Match by closest datetime (within 24 hours)
  const apiDateIso = apiMatch.utcDate;
  if (apiDateIso) {
    const apiDate = new Date(apiDateIso);
    let bestMatch = null;
    let minDiff = Infinity;

    candidates.forEach(m => {
      const mDate = new Date(m.datetime);
      const diff = Math.abs(apiDate - mDate);
      if (diff < minDiff) {
        minDiff = diff;
        bestMatch = m;
      }
    });

    if (bestMatch && minDiff < 24 * 60 * 60 * 1000) {
      return bestMatch.id;
    }
  }

  return null;
}

async function syncMatches(force = false) {
  // 1. Load local matches and config
  const localMatches = loadMatches();
  const now = new Date();
  const startTime = Date.now();

  // Load results from DB
  const resultsRes = await pool.query('SELECT match_id, score1, score2, status, penalties_winner, team1_badge, team2_badge, manual_override, match_datetime FROM results');
  const resultsMap = {};
  resultsRes.rows.forEach(r => {
    resultsMap[r.match_id] = r;
  });

  // 2. Local auto-initialization to 0x0 for started matches
  let autoInitCount = 0;
  let initDetails = [];
  const clientInit = await pool.connect();
  try {
    await clientInit.query('BEGIN');
    for (const m of localMatches) {
      const existing = resultsMap[m.id];
      const matchTime = existing && existing.match_datetime ? new Date(existing.match_datetime) : new Date(m.datetime);
      
      if (now >= matchTime) {
        const needsInit = !existing || 
                           existing.score1 === null || 
                           existing.score2 === null || 
                           existing.status === 'scheduled';
        
        const isOverride = existing && existing.manual_override;

        if (needsInit && !isOverride) {
          // Initialize to 0x0 and status live
          await clientInit.query(`
            INSERT INTO results (match_id, score1, score2, status, manual_override)
            VALUES ($1, 0, 0, 'live', FALSE)
            ON CONFLICT (match_id) DO UPDATE
            SET score1 = 0, score2 = 0, status = 'live', manual_override = FALSE
          `, [m.id]);
          
          autoInitCount++;
          initDetails.push(`Jogo #${m.id} (${m.team1} x ${m.team2}) atingiu horário de início. Inicializado localmente em 0x0 (AO VIVO).`);
          
          // Update local results map for subsequent logic
          resultsMap[m.id] = {
            ...resultsMap[m.id],
            match_id: m.id,
            score1: 0,
            score2: 0,
            status: 'live',
            manual_override: false
          };
        }
      }
    }
    await clientInit.query('COMMIT');
  } catch (err) {
    await clientInit.query('ROLLBACK');
    console.error('Error during auto-initialization of live matches:', err);
    initDetails.push(`Erro na auto-inicialização de jogos iniciados: ${err.message}`);
  } finally {
    clientInit.release();
  }

  // 3. Cooldown / Cache check
  const lastSyncRes = await pool.query("SELECT value FROM config WHERE key = 'football_api_last_sync'");
  const lastSyncStr = lastSyncRes.rows[0]?.value;

  if (lastSyncStr) {
    const lastSync = new Date(lastSyncStr);
    const timeDiffMs = now - lastSync;

    // Rígido: no máximo 1 requisição a cada 8 segundos (Limite absoluto / antispam - para 10 req/min)
    if (timeDiffMs < 8 * 1000) {
      const remainingSeconds = 8 - Math.round(timeDiffMs / 1000);
      return {
        ok: true,
        message: `Limite de cota (Football-Data.org) atingido. Aguarde ${remainingSeconds} segundos.`,
        cached: true,
        matchesSynced: autoInitCount,
        details: [
          ...initDetails,
          `Sincronização externa ignorada. Cooldown rígido ativo. Restam ${remainingSeconds}s.`
        ]
      };
    }

    // Cooldown dinâmico normal (se não for forçado)
    if (!force) {
      // Check current statuses
      const statuses = Object.values(resultsMap).map(r => r.status);
      const hasLive = statuses.some(s => s === 'live');
      const hasScheduled = statuses.some(s => s === 'scheduled') || Object.keys(resultsMap).length < localMatches.length;

      let cooldownMs = 20 * 60 * 1000; // 20 minutos se todas as partidas encerradas
      let reason = 'todas as partidas encerradas (20m)';

      if (hasLive) {
        cooldownMs = 1 * 60 * 1000; // 1 minuto se houver partidas ao vivo
        reason = 'partidas ao vivo em andamento (1m)';
      } else if (hasScheduled) {
        cooldownMs = 10 * 60 * 1000; // 10 minutos se houver partidas agendadas
        reason = 'partidas agendadas futuras (10m)';
      }

      if (timeDiffMs < cooldownMs) {
        const remMin = Math.ceil((cooldownMs - timeDiffMs) / (60 * 1000));
        return {
          ok: true,
          message: 'Sincronização externa ignorada pelo cooldown dinâmico.',
          cached: true,
          matchesSynced: autoInitCount,
          details: [
            ...initDetails,
            `Dados locais recentes devido a: ${reason}. Restam ${remMin} minutos.`
          ]
        };
      }
    }
  }

  // Update last sync timestamp immediately to prevent race conditions
  await pool.query(`
    INSERT INTO config (key, value) VALUES ('football_api_last_sync', $1)
    ON CONFLICT (key) DO UPDATE SET value = $1
  `, [now.toISOString()]);

  // 4. API External Call
  let apiKey = process.env.FOOTBALL_API_KEY || process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey || apiKey === 'sua_chave_aqui') {
    // If API key is missing, log the local initialization and exit gracefully
    const logId = uuidv4();
    await pool.query(`
      INSERT INTO sync_logs (id, timestamp, status, matches_synced, details)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      logId,
      now.toISOString(),
      autoInitCount > 0 ? 'success' : 'failure',
      autoInitCount,
      [`Auto-inicialização local: ${autoInitCount} jogos iniciados.`, 'Erro: API Key do Football-Data.org não configurada (.env).'].join('\n')
    ]);
    return {
      ok: false,
      message: 'Football-Data.org API Key não configurada. Defina FOOTBALL_API_KEY no arquivo .env.',
      matchesSynced: autoInitCount,
      details: [...initDetails, 'API Key do Football-Data.org não configurada.']
    };
  }

  let syncStatus = 'success';
  let matchesSynced = 0;
  let detailsLog = [...initDetails];

  try {
    const response = await fetch(`https://api.football-data.org/v4/competitions/2000/matches`, {
      headers: {
        'X-Auth-Token': apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`API retornou erro ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.matches || !Array.isArray(data.matches)) {
      throw new Error('Formato inválido recebido da Football-Data API (objeto "matches" esperado).');
    }

    // Load mappings
    const mappingRes = await pool.query('SELECT local_match_id, api_match_id FROM api_match_mappings');
    const mappingMap = {};
    mappingRes.rows.forEach(r => {
      mappingMap[r.api_match_id] = r.local_match_id;
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const apiMatch of data.matches) {
        const apiId = String(apiMatch.id);
        let localId = mappingMap[apiId];

        if (!localId) {
          localId = findBestLocalMatch(apiMatch, localMatches, mappingMap, resultsMap);
          if (localId) {
            await client.query(`
              INSERT INTO api_match_mappings (local_match_id, api_match_id)
              VALUES ($1, $2)
              ON CONFLICT (local_match_id) DO NOTHING
            `, [localId, apiId]);
            mappingMap[apiId] = localId; // cache local
          }
        }

        if (!localId) continue;

        const localMatch = localMatches.find(m => m.id === localId);
        if (!localMatch) continue;

        const existingResult = resultsMap[localId];
        if (existingResult && existingResult.manual_override) {
          detailsLog.push(`Jogo #${localId} (${localMatch.team1} x ${localMatch.team2}) ignorado por conter ajuste manual.`);
          continue;
        }

        // Map status
        // Football-Data statuses: TIMED, SCHEDULED, LIVE, IN_PLAY, PAUSED, FINISHED, POSTPONED, SUSPENDED, CANCELLED
        const apiStatus = (apiMatch.status || '').toUpperCase();
        let mappedStatus = 'scheduled';
        if (apiStatus === 'FINISHED') {
          mappedStatus = 'finished';
        } else if (apiStatus === 'IN_PLAY' || apiStatus === 'PAUSED' || apiStatus === 'LIVE') {
          mappedStatus = 'live';
        } else if (apiStatus === 'POSTPONED' || apiStatus === 'CANCELLED' || apiStatus === 'SUSPENDED') {
          mappedStatus = 'cancelled';
        }

        // Map scores
        const apiHomeScore = (apiMatch.score && apiMatch.score.fullTime && apiMatch.score.fullTime.home !== null) ? parseInt(apiMatch.score.fullTime.home) : null;
        const apiAwayScore = (apiMatch.score && apiMatch.score.fullTime && apiMatch.score.fullTime.away !== null) ? parseInt(apiMatch.score.fullTime.away) : null;

        // Resolve penalties
        let penaltiesWinner = null;
        if (mappedStatus === 'finished' && apiHomeScore === apiAwayScore && apiHomeScore !== null) {
          if (apiMatch.score && apiMatch.score.duration === 'PENALTY_SHOOTOUT') {
            const penHome = apiMatch.score.penalties && apiMatch.score.penalties.home;
            const penAway = apiMatch.score.penalties && apiMatch.score.penalties.away;
            if (penHome !== null && penAway !== null) {
              if (penHome > penAway) {
                penaltiesWinner = apiMatch.homeTeam.name;
              } else if (penAway > penHome) {
                penaltiesWinner = apiMatch.awayTeam.name;
              }
            }
          }
          
          if (penaltiesWinner) {
            penaltiesWinner = translateTeamNameLocal(penaltiesWinner, localMatch);
          }
        }

        const apiHomeNameTranslated = translateTeamNameLocal(apiMatch.homeTeam ? apiMatch.homeTeam.name : '', localMatch);
        const apiAwayNameTranslated = translateTeamNameLocal(apiMatch.awayTeam ? apiMatch.awayTeam.name : '', localMatch);
        const apiHomeBadge = (apiMatch.homeTeam && apiMatch.homeTeam.crest) || null;
        const apiAwayBadge = (apiMatch.awayTeam && apiMatch.awayTeam.crest) || null;

        const scoreChanged = !existingResult ||
                             existingResult.score1 !== apiHomeScore ||
                             existingResult.score2 !== apiAwayScore ||
                             existingResult.status !== mappedStatus ||
                             existingResult.team1_badge !== apiHomeBadge ||
                             existingResult.team2_badge !== apiAwayBadge ||
                             existingResult.penalties_winner !== penaltiesWinner;

        const isPlaceholderTeam1 = localMatch.team1 === 'TBD' || /^[1-3][A-L]/.test(localMatch.team1) || localMatch.team1 === '3rd';
        const isPlaceholderTeam2 = localMatch.team2 === 'TBD' || /^[1-3][A-L]/.test(localMatch.team2) || localMatch.team2 === '3rd';
        const needTeamUpdate1 = isPlaceholderTeam1 && apiMatch.homeTeam && apiMatch.homeTeam.name && apiHomeNameTranslated !== localMatch.team1;
        const needTeamUpdate2 = isPlaceholderTeam2 && apiMatch.awayTeam && apiMatch.awayTeam.name && apiAwayNameTranslated !== localMatch.team2;

        if (scoreChanged || needTeamUpdate1 || needTeamUpdate2 || !existingResult) {
          const apiDateIso = apiMatch.utcDate || localMatch.datetime;

          await client.query(`
            INSERT INTO results (match_id) VALUES ($1) ON CONFLICT (match_id) DO NOTHING
          `, [localId]);

          const updates = [];
          const values = [];
          let paramIdx = 1;

          if (apiHomeScore !== null && apiHomeScore !== undefined) {
            updates.push(`score1 = $${paramIdx++}`);
            values.push(apiHomeScore);
          } else {
            updates.push(`score1 = NULL`);
          }

          if (apiAwayScore !== null && apiAwayScore !== undefined) {
            updates.push(`score2 = $${paramIdx++}`);
            values.push(apiAwayScore);
          } else {
            updates.push(`score2 = NULL`);
          }

          updates.push(`status = $${paramIdx++}`);
          values.push(mappedStatus);

          if (penaltiesWinner) {
            updates.push(`penalties_winner = $${paramIdx++}`);
            values.push(penaltiesWinner);
          } else {
            updates.push(`penalties_winner = NULL`);
          }

          updates.push(`match_datetime = $${paramIdx++}`);
          values.push(apiDateIso);

          if (apiMatch.homeTeam && apiMatch.homeTeam.name) {
            updates.push(`team1 = $${paramIdx++}`);
            values.push(apiHomeNameTranslated);
          }
          if (apiMatch.awayTeam && apiMatch.awayTeam.name) {
            updates.push(`team2 = $${paramIdx++}`);
            values.push(apiAwayNameTranslated);
          }

          if (apiHomeBadge) {
            updates.push(`team1_badge = $${paramIdx++}`);
            values.push(apiHomeBadge);
          }
          if (apiAwayBadge) {
            updates.push(`team2_badge = $${paramIdx++}`);
            values.push(apiAwayBadge);
          }

          updates.push(`manual_override = FALSE`);
          values.push(localId);

          await client.query(`
            UPDATE results 
            SET ${updates.join(', ')} 
            WHERE match_id = $${paramIdx}
          `, values);

          // Se a partida foi finalizada, processar desafios da rodada
          if (mappedStatus === 'finished' && apiHomeScore !== null && apiAwayScore !== null) {
            const chCheck = await client.query('SELECT status FROM challenge_matches WHERE match_id = $1', [localId]);
            if (chCheck.rows.length && chCheck.rows[0].status === 'open') {
              try {
                await autoProcessChallenge(client, localId);
                detailsLog.push(`Desafio do Jogo #${localId} processado com sucesso.`);
              } catch (chErr) {
                console.error(`Error auto-processing challenge for match ${localId}:`, chErr);
                detailsLog.push(`Erro ao processar desafio do Jogo #${localId}: ${chErr.message}`);
              }
            }
          }

          matchesSynced++;
          const scoreStr = apiHomeScore !== null ? `${apiHomeScore}x${apiAwayScore}` : 'VS';
          detailsLog.push(`Jogo #${localId}: ${apiHomeNameTranslated} ${scoreStr} ${apiAwayNameTranslated} (${mappedStatus})`);
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Grava o sucesso do sync
    await pool.query(`
      INSERT INTO config (key, value) VALUES ('football_api_last_success', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1
    `, [now.toISOString()]);

  } catch (err) {
    syncStatus = 'failure';
    detailsLog.push(`Erro na sincronização: ${err.message}`);
    console.error('API sync error:', err.message);
  }

  // 4. Save to sync_logs
  const executionTime = Date.now() - startTime;
  const logId = uuidv4();
  await pool.query(`
    INSERT INTO sync_logs (id, status, matches_synced, details)
    VALUES ($1, $2, $3, $4)
  `, [logId, syncStatus, matchesSynced, detailsLog.join('\n')]);

  return {
    ok: syncStatus === 'success',
    matchesSynced,
    details: detailsLog,
    executionTimeMs: executionTime
  };
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

async function autoRollbackChallenge(client, matchId) {
  const chQuery = await client.query('SELECT status FROM challenge_matches WHERE match_id = $1', [matchId]);
  const chStatus = chQuery.rows[0]?.status;

  if (chStatus !== 'processed' && chStatus !== 'cancelled') {
    return;
  }

  const matches = loadMatches();
  const match = matches.find(m => String(m.id) === String(matchId));
  const matchLabel = match ? `${match.team1} x ${match.team2}` : `Jogo #${matchId}`;

  if (chStatus === 'processed') {
    const dists = await client.query('SELECT participant_id, amount, type FROM challenge_prize_distributions WHERE match_id = $1', [matchId]);
    for (const dist of dists.rows) {
      const pId = dist.participant_id;
      const amt = parseFloat(dist.amount);

      await client.query(
        `UPDATE wallets SET balance = balance - $1, total_won = total_won - $2 WHERE participant_id = $3`,
        [amt, dist.type === 'refund' ? 0.00 : amt, pId]
      );

      await client.query(
        `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
         VALUES ($1, $2, $3, 'challenge_rollback', $4, $5)`,
         [uuidv4(), pId, -amt, `Estorno por reabertura de resultado: ${matchLabel}`, matchId]
      );
    }
    await client.query('DELETE FROM challenge_prize_distributions WHERE match_id = $1', [matchId]);
    await client.query('DELETE FROM challenge_results WHERE match_id = $1', [matchId]);
  } else if (chStatus === 'cancelled') {
    const entriesRes = await client.query('SELECT participant_id FROM challenge_entries WHERE match_id = $1', [matchId]);
    for (const entry of entriesRes.rows) {
      const pId = entry.participant_id;
      await client.query(
        `UPDATE wallets SET balance = balance - 2.00, total_used = total_used + 2.00 WHERE participant_id = $1`,
        [pId]
      );
      await client.query(
        `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
         VALUES ($1, $2, -2.00, 'challenge_rollback', $3, $4)`,
         [uuidv4(), pId, -2.00, `Estorno de reembolso de cancelamento por reabertura: ${matchLabel}`, matchId]
      );
    }
  }

  await client.query(
    `UPDATE challenge_matches SET status = 'open' WHERE match_id = $1`,
    [matchId]
  );
}

async function autoProcessChallenge(client, matchId) {
  const resQuery = await client.query('SELECT score1, score2, status FROM results WHERE match_id = $1', [matchId]);
  if (!resQuery.rows.length || resQuery.rows[0].score1 === null || resQuery.rows[0].score2 === null) {
    return;
  }
  const realS1 = parseInt(resQuery.rows[0].score1);
  const realS2 = parseInt(resQuery.rows[0].score2);
  const mStatus = resQuery.rows[0].status;

  if (mStatus !== 'finished') return;

  const chQuery = await client.query('SELECT status FROM challenge_matches WHERE match_id = $1', [matchId]);
  const chStatus = chQuery.rows[0]?.status || 'open';

  if (chStatus === 'processed' || chStatus === 'cancelled') {
    return;
  }

  const matches = loadMatches();
  const match = matches.find(m => String(m.id) === String(matchId));
  const matchLabel = match ? `${match.team1} x ${match.team2}` : `Jogo #${matchId}`;

  const entriesRes = await client.query(
    `SELECT e.id as entry_id, e.participant_id, p.score1, p.score2
     FROM challenge_entries e
     JOIN challenge_predictions p ON e.id = p.entry_id
     WHERE e.match_id = $1`,
    [matchId]
  );
  const entries = entriesRes.rows;
  const count = entries.length;

  if (count === 0) {
    await client.query(
      `INSERT INTO challenge_matches (match_id, status) VALUES ($1, 'processed')
       ON CONFLICT (match_id) DO UPDATE SET status = 'processed'`,
      [matchId]
    );
    await client.query(
      `INSERT INTO challenge_results (match_id, status) VALUES ($1, 'finished') ON CONFLICT (match_id) DO NOTHING`,
      [matchId]
    );
    return;
  }

  if (count < 3) {
    for (const entry of entries) {
      await client.query(
        `UPDATE wallets SET balance = balance + 2.00, total_used = total_used - 2.00 WHERE participant_id = $1`,
        [entry.participant_id]
      );
      await client.query(
        `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
         VALUES ($1, $2, 2.00, 'challenge_refund', $3, $4)`,
         [uuidv4(), entry.participant_id, `Reembolso de cancelamento (mínimo < 3 inscritos): ${matchLabel}`, matchId]
      );
    }
    await client.query(
      `INSERT INTO challenge_matches (match_id, status) VALUES ($1, 'cancelled')
       ON CONFLICT (match_id) DO UPDATE SET status = 'cancelled'`,
      [matchId]
    );
    return;
  }

  const brutoPool = count * 2.00;
  const adminFee = brutoPool * 0.10;
  const netoPool = brutoPool - adminFee;

  const exactWinners = [];
  const outcomeWinners = [];
  const sign = (x1, x2) => x1 > x2 ? 1 : x1 < x2 ? -1 : 0;
  const realSign = sign(realS1, realS2);

  entries.forEach(entry => {
    const guessS1 = parseInt(entry.score1);
    const guessS2 = parseInt(entry.score2);
    const isExact = guessS1 === realS1 && guessS2 === realS2;
    const isOutcome = sign(guessS1, guessS2) === realSign;

    if (isExact) exactWinners.push(entry.participant_id);
    if (isOutcome) outcomeWinners.push(entry.participant_id);
  });

  let distributionType = '';
  let winners = [];
  let prizePerWinner = 0;

  if (exactWinners.length > 0) {
    distributionType = 'exact_score';
    winners = exactWinners;
    prizePerWinner = netoPool / exactWinners.length;
  } else if (outcomeWinners.length > 0) {
    distributionType = 'outcome';
    winners = outcomeWinners;
    prizePerWinner = netoPool / outcomeWinners.length;
  } else {
    distributionType = 'refund';
    winners = entries.map(e => e.participant_id);
    prizePerWinner = netoPool / count;
  }

  for (const pId of winners) {
    await client.query(
      `UPDATE wallets SET balance = balance + $1, total_won = total_won + $2 WHERE participant_id = $3`,
      [prizePerWinner, distributionType === 'refund' ? 0.00 : prizePerWinner, pId]
    );

    let desc = '';
    if (distributionType === 'exact_score') {
      desc = `Prêmio do Desafio (Placar Exato): ${matchLabel}`;
    } else if (distributionType === 'outcome') {
      desc = `Prêmio do Desafio (Vencedor/Empate): ${matchLabel}`;
    } else {
      desc = `Devolução proporcional do pool líquido (sem acertadores): ${matchLabel}`;
    }

    const distId = uuidv4();
    await client.query(
      `INSERT INTO challenge_prize_distributions (id, match_id, participant_id, amount, type)
       VALUES ($1, $2, $3, $4, $5)`,
      [distId, matchId, pId, prizePerWinner, distributionType]
    );

    await client.query(
      `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv4(), pId, prizePerWinner, distributionType === 'refund' ? 'challenge_refund' : 'challenge_prize', desc, matchId]
    );
  }

  await client.query(
    `INSERT INTO challenge_matches (match_id, status) VALUES ($1, 'processed')
     ON CONFLICT (match_id) DO UPDATE SET status = 'processed'`,
    [matchId]
  );

  await client.query(
    `INSERT INTO challenge_results (match_id, status) VALUES ($1, 'finished')
     ON CONFLICT (match_id) DO UPDATE SET status = 'finished'`,
    [matchId]
  );
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
      try {
        await syncMatches(false);
      } catch (syncErr) {
        console.error('Auto-sync error during GET /matches:', syncErr.message);
      }

      const matches = loadMatches();
      const { rows } = await pool.query('SELECT match_id, score1, score2, penalties_winner, status, live_link, match_datetime, team1, team2, team1_badge, team2_badge FROM results');
      const resMap = {};
      rows.forEach(r => {
        resMap[r.match_id] = {
          score1: r.score1,
          score2: r.score2,
          penalties_winner: r.penalties_winner,
          status: r.status,
          live_link: r.live_link,
          match_datetime: r.match_datetime,
          team1: r.team1,
          team2: r.team2,
          team1_badge: r.team1_badge,
          team2_badge: r.team2_badge
        };
      });
      const mapped = matches.map(m => {
        const r = resMap[m.id];
        const datetime = (r && r.match_datetime) ? r.match_datetime : m.datetime;
        const team1 = (r && r.team1) ? r.team1 : m.team1;
        const team2 = (r && r.team2) ? r.team2 : m.team2;
        const team1_badge = (r && r.team1_badge) ? r.team1_badge : null;
        const team2_badge = (r && r.team2_badge) ? r.team2_badge : null;
        const mappedMatch = {
          ...m,
          team1,
          team2,
          team1_badge,
          team2_badge,
          datetime: datetime,
          result: r || null
        };
        return {
          ...mappedMatch,
          locked: isLocked(mappedMatch) || (r && r.score1 !== null && r.score2 !== null)
        };
      });

      // Helper function to find a match winner dynamically
      function getMatchWinner(m) {
        if (!m || !m.result || m.result.score1 === null || m.result.score2 === null) return null;
        const s1 = parseInt(m.result.score1);
        const s2 = parseInt(m.result.score2);
        if (s1 > s2) return { name: m.team1, badge: m.team1_badge };
        if (s2 > s1) return { name: m.team2, badge: m.team2_badge };
        if (m.result.penalties_winner) {
          const isTeam1 = m.result.penalties_winner === m.team1;
          return {
            name: m.result.penalties_winner,
            badge: isTeam1 ? m.team1_badge : m.team2_badge
          };
        }
        return null;
      }

      // Helper function to find a match loser dynamically
      function getMatchLoser(m) {
        if (!m || !m.result || m.result.score1 === null || m.result.score2 === null) return null;
        const s1 = parseInt(m.result.score1);
        const s2 = parseInt(m.result.score2);
        if (s1 > s2) return { name: m.team2, badge: m.team2_badge };
        if (s2 > s1) return { name: m.team1, badge: m.team1_badge };
        if (m.result.penalties_winner) {
          const isTeam1 = m.result.penalties_winner === m.team1;
          return {
            name: isTeam1 ? m.team2 : m.team1,
            badge: isTeam1 ? m.team2_badge : m.team1_badge
          };
        }
        return null;
      }

      // Bracket progression definitions
      const stages = [
        // 1. Round of 32 -> Round of 16
        { pairs: [['74','77','90'], ['73','75','89'], ['83','84','94'], ['81','82','93'], ['76','78','91'], ['79','80','92'], ['86','88','96'], ['85','87','95']] },
        // 2. Round of 16 -> Quarter-finals
        { pairs: [['90','89','97'], ['94','93','98'], ['91','92','99'], ['96','95','100']] },
        // 3. Quarter-finals -> Semi-finals
        { pairs: [['97','98','101'], ['99','100','102']] },
        // 4. Semi-finals -> Final
        { pairs: [['101','102','104']] }
      ];

      stages.forEach(stage => {
        stage.pairs.forEach(([p1Id, p2Id, childId]) => {
          const p1 = mapped.find(m => String(m.id) === p1Id);
          const p2 = mapped.find(m => String(m.id) === p2Id);
          const child = mapped.find(m => String(m.id) === childId);

          if (child) {
            if (p1) {
              const w1 = getMatchWinner(p1);
              if (w1) {
                child.team1 = w1.name;
                child.team1_badge = w1.badge;
              }
            }
            if (p2) {
              const w2 = getMatchWinner(p2);
              if (w2) {
                child.team2 = w2.name;
                child.team2_badge = w2.badge;
              }
            }
          }
        });
      });

      // Special case: Third Place (103) is between losers of 101 and 102
      const sf1 = mapped.find(m => String(m.id) === '101');
      const sf2 = mapped.find(m => String(m.id) === '102');
      const thirdPlace = mapped.find(m => String(m.id) === '103');
      if (thirdPlace) {
        if (sf1) {
          const l1 = getMatchLoser(sf1);
          if (l1) {
            thirdPlace.team1 = l1.name;
            thirdPlace.team1_badge = l1.badge;
          }
        }
        if (sf2) {
          const l2 = getMatchLoser(sf2);
          if (l2) {
            thirdPlace.team2 = l2.name;
            thirdPlace.team2_badge = l2.badge;
          }
        }
      }

      // Sort by datetime chronologically (both date and time combined)
      mapped.sort((a, b) => (a.datetime || '') < (b.datetime || '') ? -1 : 1);
      return res.status(200).json(mapped);
    }

        // - PUT /matches/:id/result
    const matchResult = url.match(/^\/matches\/([^/]+)\/result$/);
    if (matchResult && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const id = matchResult[1];
      const { score1, score2, penalties_winner, status, live_link, match_datetime } = body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (score1 === null && score2 === null) {
          await autoRollbackChallenge(client, id);
          
          // Check if there is a match_datetime override
          const rCheck = await client.query('SELECT match_datetime FROM results WHERE match_id = $1', [id]);
          const hasTimeOverride = rCheck.rows.length > 0 && rCheck.rows[0].match_datetime;
          
          if (hasTimeOverride) {
            // Keep the row but clear result fields and reset manual_override to FALSE
            await client.query(
              `UPDATE results SET score1 = NULL, score2 = NULL, penalties_winner = NULL, status = NULL, live_link = NULL, manual_override = FALSE WHERE match_id = $1`,
              [id]
            );
          } else {
            // Delete the row entirely
            await client.query('DELETE FROM results WHERE match_id = $1', [id]);
          }
          
          const matches = loadMatches();
          const m = matches.find(x => String(x.id) === String(id));
          if (m && (String(m.id) === '104' || m.round === 'Final')) {
            await client.query("DELETE FROM config WHERE key='champion'");
          }
        } else {
          if (score1 === null || score1 === undefined) {
            await autoRollbackChallenge(client, id);
          } else if (status === 'finished') {
            await autoRollbackChallenge(client, id);
          }

          const updates = [];
          const values = [];
          let paramIdx = 1;

          if (score1 !== undefined) {
            updates.push(`score1 = $${paramIdx++}`);
            values.push(score1);
          }
          if (score2 !== undefined) {
            updates.push(`score2 = $${paramIdx++}`);
            values.push(score2);
          }
          if (penalties_winner !== undefined) {
            updates.push(`penalties_winner = $${paramIdx++}`);
            values.push(penalties_winner);
          }
          if (status !== undefined) {
            updates.push(`status = $${paramIdx++}`);
            values.push(status);
          }
          if (live_link !== undefined) {
            updates.push(`live_link = $${paramIdx++}`);
            values.push(live_link);
          }
          if (match_datetime !== undefined) {
            updates.push(`match_datetime = $${paramIdx++}`);
            values.push(match_datetime);
          }

          // Mark as manually overridden if score or status is updated manually
          if (score1 !== undefined || score2 !== undefined || penalties_winner !== undefined || status !== undefined) {
            updates.push(`manual_override = TRUE`);
          }

          if (updates.length > 0) {
            await client.query(`INSERT INTO results (match_id) VALUES ($1) ON CONFLICT (match_id) DO NOTHING`, [id]);
            values.push(id);
            await client.query(`UPDATE results SET ${updates.join(', ')} WHERE match_id = $${paramIdx}`, values);
          }

          const matches = loadMatches();
          const m = matches.find(x => String(x.id) === String(id));
          if (m && (String(m.id) === '104' || m.round === 'Final') && score1 !== undefined && score1 !== null) {
            let champion = null;
            if (score1 > score2) champion = m.team1;
            else if (score2 > score1) champion = m.team2;
            else champion = penalties_winner;
            
            if (champion) {
              await client.query(
                `INSERT INTO config (key, value) VALUES ('champion', $1)
                 ON CONFLICT (key) DO UPDATE SET value=$1`,
                [champion]
              );
            } else {
              await client.query("DELETE FROM config WHERE key='champion'");
            }
          }

          if (status === 'finished' && score1 !== undefined && score1 !== null) {
            await autoProcessChallenge(client, id);
          }
        }

        await client.query('COMMIT');
        return res.status(200).json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Update match result error:', e);
        return res.status(500).json({ error: 'Erro ao salvar resultado: ' + e.message });
      } finally {
        client.release();
      }
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
      const { rows } = await pool.query('SELECT id, name, phone, cotas, referred_by, approved FROM participants WHERE approved = FALSE ORDER BY name');
      return res.status(200).json(rows);
    }

    // POST /participants/request (Public referral request)
    if (url === '/participants/request' && method === 'POST') {
      const { name, pin, phone, cotas, referred_by } = body;
      if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
      if (!pin || String(pin).length < 4) return res.status(400).json({ error: 'PIN deve ter pelo menos 4 dígitos' });
      const exists = await pool.query('SELECT id FROM participants WHERE LOWER(name)=LOWER($1)', [name]);
      if (exists.rows.length) return res.status(400).json({ error: 'Participante já existe' });
      const id = uuidv4();
      const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
      let cotasVal = parseInt(cotas !== undefined ? cotas : 1);
      if (isNaN(cotasVal) || cotasVal < 1) cotasVal = 1;
      
      // Inserts with approved=FALSE
      await pool.query('INSERT INTO participants (id,name,pin,phone,cotas,referred_by,approved) VALUES ($1,$2,$3,$4,$5,$6,FALSE)', 
        [id, name.trim(), String(pin), cleanPhone || null, cotasVal, referred_by || null]);
      return res.status(200).json({ id, name: name.trim(), cotas: cotasVal, referred_by });
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

      // Block bets once the match has started or score is defined
      const match = loadMatches().find(m => m.id === String(matchId));
      if (!match) return res.status(404).json({ error: 'Partida não encontrada' });

      const resCheck = await pool.query('SELECT score1, score2, status, match_datetime FROM results WHERE match_id = $1', [String(matchId)]);
      const scoreDefined = resCheck.rows.length > 0 && resCheck.rows[0].score1 !== null && resCheck.rows[0].score2 !== null;

      if (resCheck.rows.length) {
        match.result = resCheck.rows[0];
        if (resCheck.rows[0].match_datetime) {
          match.datetime = resCheck.rows[0].match_datetime;
        }
      }

      if (isLocked(match) || scoreDefined) {
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
      const bets    = await pool.query('SELECT participant_id, match_id, score1, score2, created_at FROM bets');
      const results = await pool.query('SELECT match_id, score1, score2, match_datetime FROM results');
      const resMap  = {};
      results.rows.forEach(r => {
        resMap[r.match_id] = {
          score1: r.score1,
          score2: r.score2,
          match_datetime: r.match_datetime
        };
      });
      const ranking = parts.rows.map(p => {
        // Only count bets for matches on or after Brazil's first game (2026-06-20T00:00:00Z)
        const myBets = bets.rows.filter(b => {
          if (b.participant_id !== p.id) return false;
          const m = loadMatches().find(x => String(x.id) === String(b.match_id));
          if (!m) return false;
          const r = resMap[b.match_id];
          const datetime = (r && r.match_datetime) ? r.match_datetime : m.datetime;
          return datetime >= '2026-06-20T00:00:00Z';
        });
        
        // Group bets by match_id
        const betsByMatch = {};
        myBets.forEach(b => {
          if (!betsByMatch[b.match_id]) {
            betsByMatch[b.match_id] = [];
          }
          betsByMatch[b.match_id].push(b);
        });
        let points = 0, exact = 0, outcome = 0;
        let lastBetTime = null;

        Object.keys(betsByMatch).forEach(matchId => {
          const matchBets = betsByMatch[matchId];
          const r = resMap[matchId];
          
          let maxPts = 0;
          matchBets.forEach(b => {
            const pts = r ? calcScore(b.score1, b.score2, r.score1, r.score2) : 0;
            if (pts > maxPts) {
              maxPts = pts;
            }
            if (b.score1 !== null && b.score2 !== null) {
              const t = b.created_at ? new Date(b.created_at).getTime() : 0;
              if (t > 0) {
                if (lastBetTime === null || t > lastBetTime) {
                  lastBetTime = t;
                }
              }
            }
          });
          
          points += maxPts;
          if (maxPts === 3) exact++;
          else if (maxPts === 1) outcome++;
        });

        return { 
          id: p.id, 
          name: p.name, 
          cotas: p.cotas, 
          points, 
          exact, 
          outcome, 
          betted: myBets.length, 
          lastBetTime 
        };
      });

      ranking.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.exact !== a.exact) return b.exact - a.exact;
        const timeA = a.lastBetTime === null ? Infinity : a.lastBetTime;
        const timeB = b.lastBetTime === null ? Infinity : b.lastBetTime;
        return timeA - timeB;
      });

      const cleanedRanking = ranking.map(({ lastBetTime, ...rest }) => rest);
      return res.status(200).json(cleanedRanking);
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

    // GET /config/countdown
    if (url === '/config/countdown' && method === 'GET') {
      const r = await pool.query(`SELECT value FROM config WHERE key = 'countdown'`);
      const val = r.rows[0]?.value;
      if (val) {
        try {
          return res.status(200).json(JSON.parse(val));
        } catch (e) {
          // If JSON parse fails, return default structure
        }
      }
      return res.status(200).json({ active: false, title: '', body: '', target: '' });
    }

    // PUT /config/countdown
    if (url === '/config/countdown' && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { active, title, body: cBody, target } = body;
      const jsonValue = JSON.stringify({
        active: !!active,
        title: String(title || ''),
        body: String(cBody || ''),
        target: String(target || '')
      });
      await pool.query(
        `INSERT INTO config (key, value) VALUES ('countdown', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1`,
        [jsonValue]
      );
      return res.status(200).json({ ok: true });
    }


    // GET /push/vapid-public-key
    if (url === '/push/vapid-public-key' && method === 'GET') {
      if (!vapidPublicKey) {
        return res.status(500).json({ error: 'Chaves VAPID não configuradas no servidor.' });
      }
      return res.status(200).json({ publicKey: vapidPublicKey });
    }

    // POST /push/subscribe
    if (url === '/push/subscribe' && method === 'POST') {
      const { subscription, participantId } = body;
      if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ error: 'Assinatura inválida' });
      }
      const id = uuidv4();
      const auth = subscription.keys ? subscription.keys.auth : '';
      const p256dh = subscription.keys ? subscription.keys.p256dh : '';
      
      await pool.query(`
        INSERT INTO push_subscriptions (id, participant_id, endpoint, keys_auth, keys_p256dh)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (endpoint) DO UPDATE SET participant_id = $2, keys_auth = $4, keys_p256dh = $5
      `, [id, participantId || null, subscription.endpoint, auth, p256dh]);
      
      return res.status(200).json({ ok: true });
    }

    // POST /push/send (Requires admin-pin check)
    if (url === '/push/send' && method === 'POST') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
        
      if (!vapidPublicKey || !vapidPrivateKey) {
        return res.status(500).json({ error: 'Chaves VAPID não configuradas no servidor.' });
      }
        
      const { title, body: msgBody, url: clickUrl } = body;
      if (!title || !msgBody) {
        return res.status(400).json({ error: 'Título e mensagem obrigatórios' });
      }
      
      const { rows } = await pool.query('SELECT endpoint, keys_auth as "auth", keys_p256dh as "p256dh" FROM push_subscriptions');
      
      const payload = JSON.stringify({
        title: title,
        body: msgBody,
        url: clickUrl || '/'
      });
      
      const sendPromises = rows.map(sub => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            auth: sub.auth,
            p256dh: sub.p256dh
          }
        };
        return webpush.sendNotification(pushSubscription, payload)
          .catch(err => {
            console.error('Erro enviando push para endpoint:', sub.endpoint, err.message);
            if (err.statusCode === 410 || err.statusCode === 404) {
              return pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])
                .catch(e => console.error('Erro deletando push subscription expirada:', e.message));
            }
          });
      });
      
      await Promise.all(sendPromises);
      // Log to comm_log
      await pool.query(
        `INSERT INTO comm_log (id, type, sub_type, message, detail, recipient_count) VALUES ($1, 'push', NULL, $2, $3, $4)`,
        [uuidv4(), msgBody, title, rows.length]
      ).catch(e => console.error('comm_log push insert:', e.message));
      return res.status(200).json({ ok: true, count: rows.length });
    }

    // ─── GET /banners/active (public) ─────────────────────────────────────────────
    if (url === '/banners/active' && method === 'GET') {
      const { rows } = await pool.query(`SELECT id, message, type FROM banners WHERE active = TRUE LIMIT 1`);
      return res.status(200).json(rows[0] || null);
    }

    // ─── GET /banners (admin only) ────────────────────────────────────────────────
    if (url === '/banners' && method === 'GET') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { rows } = await pool.query(`SELECT id, message, type, active, created_at FROM banners ORDER BY created_at DESC LIMIT 50`);
      return res.status(200).json(rows);
    }

    // ─── POST /banners (create + activate) ────────────────────────────────────────
    if (url === '/banners' && method === 'POST') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { message, type } = body;
      if (!message || !message.trim()) return res.status(400).json({ error: 'Mensagem obrigatória' });
      const validTypes = ['warning', 'success', 'danger'];
      const bannerType = validTypes.includes(type) ? type : 'warning';
      const id = uuidv4();
      // Deactivate all existing banners first
      await pool.query(`UPDATE banners SET active = FALSE`);
      await pool.query(
        `INSERT INTO banners (id, message, type, active) VALUES ($1, $2, $3, TRUE)`,
        [id, message.trim(), bannerType]
      );
      // Log to comm_log
      await pool.query(
        `INSERT INTO comm_log (id, type, sub_type, message, detail, recipient_count) VALUES ($1, 'banner', $2, $3, NULL, NULL)`,
        [uuidv4(), bannerType, message.trim()]
      ).catch(e => console.error('comm_log banner insert:', e.message));
      return res.status(200).json({ id, ok: true });
    }

    // ─── PUT /banners/:id/activate ────────────────────────────────────────────────
    const bannerActivate = url.match(/^\/banners\/([^/]+)\/activate$/);
    if (bannerActivate && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const bid = bannerActivate[1];
      await pool.query(`UPDATE banners SET active = FALSE`);
      const result = await pool.query(`UPDATE banners SET active = TRUE WHERE id = $1 RETURNING message, type`, [bid]);
      if (result.rows.length) {
        await pool.query(
          `INSERT INTO comm_log (id, type, sub_type, message, detail, recipient_count) VALUES ($1, 'banner', $2, $3, 'reativado', NULL)`,
          [uuidv4(), result.rows[0].type, result.rows[0].message]
        ).catch(e => console.error('comm_log banner activate:', e.message));
      }
      return res.status(200).json({ ok: true });
    }

    // ─── PUT /banners/:id/deactivate ──────────────────────────────────────────────
    const bannerDeactivate = url.match(/^\/banners\/([^/]+)\/deactivate$/);
    if (bannerDeactivate && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      await pool.query(`UPDATE banners SET active = FALSE WHERE id = $1`, [bannerDeactivate[1]]);
      return res.status(200).json({ ok: true });
    }

    // ─── DELETE /banners/:id ──────────────────────────────────────────────────────
    const bannerDelete = url.match(/^\/banners\/([^/]+)$/);
    if (bannerDelete && method === 'DELETE') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      await pool.query(`DELETE FROM banners WHERE id = $1`, [bannerDelete[1]]);
      return res.status(200).json({ ok: true });
    }

    // ─── GET /comm-log (admin only) ───────────────────────────────────────────────
    if (url === '/comm-log' && method === 'GET') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });
      const { rows } = await pool.query(
        `SELECT id, type, sub_type, message, detail, recipient_count, created_at FROM comm_log ORDER BY created_at DESC LIMIT 200`
      );
      return res.status(200).json(rows);
    }

    // ─── WALLET & CHALLENGE ROUTES ───

    // GET /wallet/summary (participant only)
    if (url === '/wallet/summary' && method === 'GET') {
      const pId = req.headers['x-participant-id'];
      const pPin = req.headers['x-participant-pin'];
      if (!pId || !pPin) return res.status(401).json({ error: 'Não autorizado' });
      const pCheck = await pool.query('SELECT pin, approved, cotas, created_at FROM participants WHERE id=$1', [pId]);
      if (!pCheck.rows.length || pCheck.rows[0].pin !== String(pPin) || pCheck.rows[0].approved === false) {
        return res.status(401).json({ error: 'Não autorizado' });
      }

      await pool.query(
        `INSERT INTO wallets (participant_id, balance, total_deposited, total_used, total_won, total_withdrawn)
         VALUES ($1, 0, 0, 0, 0, 0)
         ON CONFLICT (participant_id) DO NOTHING`,
        [pId]
      );

      const participant = pCheck.rows[0];
      const cotasCount = participant.cotas || 1;
      const createdAt = participant.created_at || new Date();

      const cotaRes = await pool.query(`SELECT value FROM config WHERE key = 'valor_cota'`);
      const valorCota = parseFloat(cotaRes.rows[0]?.value || '25');

      const walletRes = await pool.query('SELECT balance, total_deposited, total_used, total_won, total_withdrawn FROM wallets WHERE participant_id = $1', [pId]);
      const wallet = walletRes.rows[0];

      const txRes = await pool.query('SELECT id, amount, type, description, created_at FROM wallet_transactions WHERE participant_id = $1 ORDER BY created_at DESC', [pId]);
      const depRes = await pool.query('SELECT id, amount, receipt, status, created_at FROM wallet_deposits WHERE participant_id = $1 ORDER BY created_at DESC', [pId]);

      // Construct a virtual transaction for the bolao cota entry
      const virtualTx = {
        id: 'bolao-entry-virtual',
        amount: - (cotasCount * valorCota),
        type: 'bolao_entry',
        description: `Inscrição no Bolão (${cotasCount} cota${cotasCount > 1 ? 's' : ''} a R$ ${valorCota.toFixed(2).replace('.', ',')} cada)`,
        created_at: createdAt
      };

      const transactions = txRes.rows.map(tx => ({
        id: tx.id,
        amount: parseFloat(tx.amount),
        type: tx.type,
        description: tx.description,
        created_at: tx.created_at
      }));

      transactions.push(virtualTx);
      transactions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      return res.status(200).json({
        wallet: {
          balance: parseFloat(wallet.balance),
          total_deposited: parseFloat(wallet.total_deposited),
          total_used: parseFloat(wallet.total_used),
          total_won: parseFloat(wallet.total_won),
          total_withdrawn: parseFloat(wallet.total_withdrawn)
        },
        transactions: transactions,
        deposits: depRes.rows.map(dep => ({ ...dep, amount: parseFloat(dep.amount) }))
      });
    }

    // POST /wallet/deposit (participant only)
    if (url === '/wallet/deposit' && method === 'POST') {
      const pId = req.headers['x-participant-id'];
      const pPin = req.headers['x-participant-pin'];
      if (!pId || !pPin) return res.status(401).json({ error: 'Não autorizado' });
      const pCheck = await pool.query('SELECT pin, approved FROM participants WHERE id=$1', [pId]);
      if (!pCheck.rows.length || pCheck.rows[0].pin !== String(pPin) || pCheck.rows[0].approved === false) {
        return res.status(401).json({ error: 'Não autorizado' });
      }

      const { amount, receipt } = body;
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount < 2.00) {
        return res.status(400).json({ error: 'Valor mínimo de depósito é R$ 2,00' });
      }
      if (!receipt || !receipt.trim()) {
        return res.status(400).json({ error: 'Comprovante/descrição é obrigatório' });
      }

      const depositId = uuidv4();
      await pool.query(
        `INSERT INTO wallet_deposits (id, participant_id, amount, receipt, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [depositId, pId, parsedAmount, receipt.trim()]
      );

      return res.status(200).json({ ok: true, depositId });
    }

    // POST /challenge/enter (participant only)
    if (url === '/challenge/enter' && method === 'POST') {
      const pId = req.headers['x-participant-id'];
      const pPin = req.headers['x-participant-pin'];
      if (!pId || !pPin) return res.status(401).json({ error: 'Não autorizado' });
      const pCheck = await pool.query('SELECT pin, approved FROM participants WHERE id=$1', [pId]);
      if (!pCheck.rows.length || pCheck.rows[0].pin !== String(pPin) || pCheck.rows[0].approved === false) {
        return res.status(401).json({ error: 'Não autorizado' });
      }

      const { matchId, score1, score2 } = body;
      const s1 = parseInt(score1);
      const s2 = parseInt(score2);
      if (isNaN(s1) || isNaN(s2) || s1 < 0 || s2 < 0) {
        return res.status(400).json({ error: 'Palpite inválido' });
      }

      const matches = loadMatches();
      const match = matches.find(m => String(m.id) === String(matchId));
      if (!match) return res.status(404).json({ error: 'Partida não encontrada' });

      const resCheck = await pool.query('SELECT score1, score2, status, match_datetime FROM results WHERE match_id = $1', [String(matchId)]);
      const scoreDefined = resCheck.rows.length > 0 && resCheck.rows[0].score1 !== null && resCheck.rows[0].score2 !== null;

      if (resCheck.rows.length) {
        match.result = resCheck.rows[0];
        if (resCheck.rows[0].match_datetime) {
          match.datetime = resCheck.rows[0].match_datetime;
        }
      }

      if (isLocked(match) || scoreDefined) return res.status(403).json({ error: 'Os palpites para esta partida já foram encerrados' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `INSERT INTO wallets (participant_id, balance, total_deposited, total_used, total_won, total_withdrawn)
           VALUES ($1, 0, 0, 0, 0, 0)
           ON CONFLICT (participant_id) DO NOTHING`,
          [pId]
        );

        const balanceRes = await client.query('SELECT balance FROM wallets WHERE participant_id = $1 FOR UPDATE', [pId]);
        const balance = parseFloat(balanceRes.rows[0].balance);
        if (balance < 2.00) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Saldo insuficiente' });
        }

        const checkEntry = await client.query('SELECT id FROM challenge_entries WHERE participant_id = $1 AND match_id = $2', [pId, matchId]);
        if (checkEntry.rows.length) {
          const entryId = checkEntry.rows[0].id;
          await client.query(
            `UPDATE challenge_predictions SET score1 = $1, score2 = $2 WHERE entry_id = $3`,
            [s1, s2, entryId]
          );
          await client.query('COMMIT');
          return res.status(200).json({ ok: true });
        }

        await client.query(
          `UPDATE wallets SET balance = balance - 2.00, total_used = total_used + 2.00 WHERE participant_id = $1`,
          [pId]
        );

        await client.query(
          `INSERT INTO challenge_matches (match_id, status) VALUES ($1, 'open') ON CONFLICT (match_id) DO NOTHING`,
          [matchId]
        );

        const entryId = uuidv4();
        await client.query(
          `INSERT INTO challenge_entries (id, participant_id, match_id) VALUES ($1, $2, $3)`,
          [entryId, pId, matchId]
        );

        await client.query(
          `INSERT INTO challenge_predictions (entry_id, score1, score2) VALUES ($1, $2, $3)`,
          [entryId, s1, s2]
        );

        await client.query(
          `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
           VALUES ($1, $2, -2.00, 'challenge_entry', $3, $4)`,
          [uuidv4(), pId, `Inscrição no Desafio da Partida: ${match.team1} x ${match.team2}`, matchId]
        );

        await client.query('COMMIT');
        return res.status(200).json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Challenge enter error:', e);
        return res.status(500).json({ error: 'Erro ao processar inscrição: ' + e.message });
      } finally {
        client.release();
      }
    }

    // GET /challenge/matches
    if (url === '/challenge/matches' && method === 'GET') {
      const pId = req.headers['x-participant-id'];

      const countsRes = await pool.query(
        `SELECT match_id, COUNT(*) as count FROM challenge_entries GROUP BY match_id`
      );
      const countMap = {};
      countsRes.rows.forEach(r => { countMap[r.match_id] = parseInt(r.count); });

      const statusRes = await pool.query(`SELECT match_id, status FROM challenge_matches`);
      const statusMap = {};
      statusRes.rows.forEach(r => { statusMap[r.match_id] = r.status; });

      const myPreds = {};
      if (pId) {
        const myRes = await pool.query(
          `SELECT e.match_id, p.score1, p.score2 
           FROM challenge_entries e
           JOIN challenge_predictions p ON e.id = p.entry_id
           WHERE e.participant_id = $1`,
          [pId]
        );
        myRes.rows.forEach(r => {
          myPreds[r.match_id] = { score1: r.score1, score2: r.score2 };
        });
      }

      const myPrizes = {};
      if (pId) {
        const prizeRes = await pool.query(
          `SELECT match_id, amount, type FROM challenge_prize_distributions WHERE participant_id = $1`,
          [pId]
        );
        prizeRes.rows.forEach(r => {
          myPrizes[r.match_id] = { amount: parseFloat(r.amount), type: r.type };
        });
      }

      return res.status(200).json({
        counts: countMap,
        statuses: statusMap,
        myPredictions: myPreds,
        myPrizes: myPrizes
      });
    }

    // GET /challenge/history (participant only)
    if (url === '/challenge/history' && method === 'GET') {
      const pId = req.headers['x-participant-id'];
      const pPin = req.headers['x-participant-pin'];
      if (!pId || !pPin) return res.status(401).json({ error: 'Não autorizado' });
      const pCheck = await pool.query('SELECT pin, approved FROM participants WHERE id=$1', [pId]);
      if (!pCheck.rows.length || pCheck.rows[0].pin !== String(pPin) || pCheck.rows[0].approved === false) {
        return res.status(401).json({ error: 'Não autorizado' });
      }

      const betsRes = await pool.query(
        `SELECT b.match_id as "matchId", b.score1, b.score2, b.cota_index as "cotaIndex"
         FROM bets b
         WHERE b.participant_id = $1
         ORDER BY b.created_at DESC`,
        [pId]
      );

      const challengeRes = await pool.query(
        `SELECT e.match_id as "matchId", p.score1, p.score2, e.created_at,
                m.status as "matchStatus",
                dist.amount as "prize", dist.type as "prizeType",
                (SELECT COUNT(*) FROM challenge_entries WHERE match_id = e.match_id) as "totalParticipants"
         FROM challenge_entries e
         JOIN challenge_predictions p ON e.id = p.entry_id
         LEFT JOIN challenge_matches m ON e.match_id = m.match_id
         LEFT JOIN challenge_prize_distributions dist ON e.match_id = dist.match_id AND dist.participant_id = $1
         WHERE e.participant_id = $1
         ORDER BY e.created_at DESC`,
        [pId]
      );

      const matches = loadMatches();
      const resultsRes = await pool.query('SELECT match_id, score1, score2, status FROM results');
      const resMap = {};
      resultsRes.rows.forEach(r => { resMap[r.match_id] = { score1: r.score1, score2: r.score2, status: r.status }; });

      return res.status(200).json({
        bolao: betsRes.rows,
        desafios: challengeRes.rows.map(c => ({
          ...c,
          prize: c.prize ? parseFloat(c.prize) : 0,
          totalParticipants: c.totalParticipants ? parseInt(c.totalParticipants) : 0
        })),
        results: resMap,
        matches: matches
      });
    }

    // ─── ADMIN FINANCE & CHALLENGE ROUTES ───

    // GET /admin/deposits/pending (admin only)
    if (url === '/admin/deposits/pending' && method === 'GET') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const { rows } = await pool.query(
        `SELECT d.id, d.participant_id as "participantId", p.name as "participantName", d.amount, d.receipt, d.created_at
         FROM wallet_deposits d
         JOIN participants p ON d.participant_id = p.id
         WHERE d.status = 'pending'
         ORDER BY d.created_at DESC`
      );
      return res.status(200).json(rows.map(r => ({ ...r, amount: parseFloat(r.amount) })));
    }

    // PUT /admin/deposits/:id/approve (admin only)
    const approveDeposit = url.match(/^\/admin\/deposits\/([^/]+)\/approve$/);
    if (approveDeposit && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const depositId = approveDeposit[1];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const depCheck = await client.query('SELECT participant_id, amount, status FROM wallet_deposits WHERE id = $1 FOR UPDATE', [depositId]);
        if (!depCheck.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Solicitação não encontrada' });
        }
        const dep = depCheck.rows[0];
        if (dep.status !== 'pending') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Solicitação já processada' });
        }

        const pId = dep.participant_id;
        const amount = parseFloat(dep.amount);

        await client.query(
          `INSERT INTO wallets (participant_id, balance, total_deposited, total_used, total_won, total_withdrawn)
           VALUES ($1, 0, 0, 0, 0, 0)
           ON CONFLICT (participant_id) DO NOTHING`,
          [pId]
        );

        await client.query(`UPDATE wallet_deposits SET status = 'approved' WHERE id = $1`, [depositId]);

        await client.query(
          `UPDATE wallets SET balance = balance + $1, total_deposited = total_deposited + $1 WHERE participant_id = $2`,
          [amount, pId]
        );

        await client.query(
          `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
           VALUES ($1, $2, $3, 'deposit', 'Crédito de depósito PIX aprovado', $4)`,
          [uuidv4(), pId, amount, depositId]
        );

        await client.query('COMMIT');
        return res.status(200).json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Approve deposit error:', e);
        return res.status(500).json({ error: 'Erro ao aprovar depósito: ' + e.message });
      } finally {
        client.release();
      }
    }

    // PUT /admin/deposits/:id/reject (admin only)
    const rejectDeposit = url.match(/^\/admin\/deposits\/([^/]+)\/reject$/);
    if (rejectDeposit && method === 'PUT') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const depositId = rejectDeposit[1];
      const resUpdate = await pool.query(`UPDATE wallet_deposits SET status = 'rejected' WHERE id = $1 AND status = 'pending'`, [depositId]);
      if (resUpdate.rowCount === 0) {
        return res.status(404).json({ error: 'Solicitação não encontrada ou já processada' });
      }
      return res.status(200).json({ ok: true });
    }

    // POST /admin/wallet/adjust (admin only)
    if (url === '/admin/wallet/adjust' && method === 'POST') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const { participantId, amount, description } = body;
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount === 0) {
        return res.status(400).json({ error: 'Valor inválido para ajuste' });
      }
      if (!description || !description.trim()) {
        return res.status(400).json({ error: 'Descrição é obrigatória' });
      }

      const pCheck = await pool.query('SELECT name FROM participants WHERE id = $1', [participantId]);
      if (!pCheck.rows.length) {
        return res.status(404).json({ error: 'Participante não encontrado' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `INSERT INTO wallets (participant_id, balance, total_deposited, total_used, total_won, total_withdrawn)
           VALUES ($1, 0, 0, 0, 0, 0)
           ON CONFLICT (participant_id) DO NOTHING`,
          [participantId]
        );

        const walletRes = await client.query('SELECT balance FROM wallets WHERE participant_id = $1 FOR UPDATE', [participantId]);
        const currentBalance = parseFloat(walletRes.rows[0].balance);
        if (currentBalance + parsedAmount < 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Saldo final não pode ser menor que zero' });
        }

        await client.query(
          `UPDATE wallets SET balance = balance + $1 WHERE participant_id = $2`,
          [parsedAmount, participantId]
        );

        await client.query(
          `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
           VALUES ($1, $2, $3, 'manual_adjustment', $4, NULL)`,
          [uuidv4(), participantId, parsedAmount, description.trim()]
        );

        await client.query('COMMIT');
        return res.status(200).json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Wallet adjust error:', e);
        return res.status(500).json({ error: 'Erro ao ajustar saldo: ' + e.message });
      } finally {
        client.release();
      }
    }

    // GET /admin/transactions (admin only)
    if (url === '/admin/transactions' && method === 'GET') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const { rows } = await pool.query(
        `SELECT t.id, t.participant_id as "participantId", p.name as "participantName", t.amount, t.type, t.description, t.created_at
         FROM wallet_transactions t
         JOIN participants p ON t.participant_id = p.id
         ORDER BY t.created_at DESC`
      );
      return res.status(200).json(rows.map(r => ({ ...r, amount: parseFloat(r.amount) })));
    }

    // GET /admin/sync-status (admin only)
    if (url === '/admin/sync-status' && method === 'GET') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const lastSyncRes = await pool.query("SELECT value FROM config WHERE key = 'football_api_last_sync'");
      const lastSuccessRes = await pool.query("SELECT value FROM config WHERE key = 'football_api_last_success'");
      
      const logsRes = await pool.query(`
        SELECT id, timestamp, status, matches_synced, details 
        FROM sync_logs 
        ORDER BY timestamp DESC 
        LIMIT 20
      `);

      const apiKey = process.env.FOOTBALL_API_KEY || process.env.FOOTBALL_DATA_API_KEY;
      const apiConfigured = apiKey && apiKey !== 'sua_chave_aqui' && apiKey !== '';

      return res.status(200).json({
        lastSync: lastSyncRes.rows[0]?.value || null,
        lastSuccess: lastSuccessRes.rows[0]?.value || null,
        apiConfigured: !!apiConfigured,
        recentLogs: logsRes.rows
      });
    }

    // POST /admin/sync/force (admin only)
    if (url === '/admin/sync/force' && method === 'POST') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      try {
        const result = await syncMatches(true); // force = true
        return res.status(200).json(result);
      } catch (e) {
        console.error('Manual force sync error:', e);
        return res.status(500).json({ error: e.message });
      }
    }

    // POST /admin/reprocess-all (admin only)
    if (url === '/admin/reprocess-all' && method === 'POST') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        const finishedMatchesRes = await client.query(`
          SELECT match_id FROM results 
          WHERE status = 'finished' AND score1 IS NOT NULL AND score2 IS NOT NULL
        `);
        
        let processedCount = 0;
        for (const row of finishedMatchesRes.rows) {
          const chCheck = await client.query('SELECT status FROM challenge_matches WHERE match_id = $1', [row.match_id]);
          if (chCheck.rows.length && chCheck.rows[0].status === 'processed') {
            await autoRollbackChallenge(client, row.match_id);
          }
          await autoProcessChallenge(client, row.match_id);
          processedCount++;
        }

        await client.query('COMMIT');
        
        await pool.query(
          `INSERT INTO comm_log (id, type, sub_type, message, detail, recipient_count) 
           VALUES ($1, 'system', 'reprocess_all', $2, NULL, NULL)`,
          [uuidv4(), `Reprocessamento manual de todas as pontuações e desafios. Partidas reprocessadas: ${processedCount}`]
        ).catch(e => console.error('comm_log reprocess_all insert:', e.message));

        return res.status(200).json({ ok: true, message: `Reprocessamento concluído. ${processedCount} partidas reprocessadas.` });
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Reprocess all error:', e);
        return res.status(500).json({ error: e.message });
      } finally {
        client.release();
      }
    }

    // GET /admin/wallets (admin only)
    if (url === '/admin/wallets' && method === 'GET') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const { rows } = await pool.query(
        `SELECT p.id as "participantId", p.name as "participantName",
                COALESCE(w.balance, 0.00) as "balance",
                COALESCE(w.total_deposited, 0.00) as "totalDeposited",
                COALESCE(w.total_used, 0.00) as "totalUsed",
                COALESCE(w.total_won, 0.00) as "totalWon",
                COALESCE(w.total_withdrawn, 0.00) as "totalWithdrawn"
         FROM participants p
         LEFT JOIN wallets w ON p.id = w.participant_id
         WHERE p.approved = TRUE
         ORDER BY p.name`
      );
      return res.status(200).json(rows.map(r => ({
        ...r,
        balance: parseFloat(r.balance),
        totalDeposited: parseFloat(r.totalDeposited),
        totalUsed: parseFloat(r.totalUsed),
        totalWon: parseFloat(r.totalWon),
        totalWithdrawn: parseFloat(r.totalWithdrawn)
      })));
    }


    // GET /admin/challenges/predictions (admin only)
    if (url === '/admin/challenges/predictions' && method === 'GET') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const { rows } = await pool.query(
        `SELECT e.id, e.participant_id as "participantId", e.match_id as "matchId", pr.score1, pr.score2, e.created_at as "createdAt"
         FROM challenge_entries e
         JOIN challenge_predictions pr ON e.id = pr.entry_id
         ORDER BY e.created_at DESC`
      );
      return res.status(200).json(rows);
    }

    // GET /admin/challenges/:matchId/entries (admin only)
    const adminEntries = url.match(/^\/admin\/challenges\/([^/]+)\/entries$/);
    if (adminEntries && method === 'GET') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const matchId = adminEntries[1];
      const { rows } = await pool.query(
        `SELECT e.participant_id as "participantId", p.name as "participantName", pr.score1, pr.score2, e.created_at
         FROM challenge_entries e
         JOIN challenge_predictions pr ON e.id = pr.entry_id
         JOIN participants p ON e.participant_id = p.id
         WHERE e.match_id = $1
         ORDER BY e.created_at ASC`,
        [matchId]
      );
      return res.status(200).json(rows);
    }

    // POST /admin/challenges/:matchId/cancel (admin only)
    const adminCancelChallenge = url.match(/^\/admin\/challenges\/([^/]+)\/cancel$/);
    if (adminCancelChallenge && method === 'POST') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const matchId = adminCancelChallenge[1];
      const matches = loadMatches();
      const match = matches.find(m => String(m.id) === String(matchId));
      const matchLabel = match ? `${match.team1} x ${match.team2}` : `Jogo #${matchId}`;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const chCheck = await client.query('SELECT status FROM challenge_matches WHERE match_id = $1 FOR UPDATE', [matchId]);
        if (!chCheck.rows.length) {
          await client.query(
            `INSERT INTO challenge_matches (match_id, status) VALUES ($1, 'open') ON CONFLICT (match_id) DO NOTHING`,
            [matchId]
          );
        } else if (chCheck.rows[0].status === 'cancelled') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Desafio já está cancelado' });
        }

        const entries = await client.query('SELECT id, participant_id FROM challenge_entries WHERE match_id = $1', [matchId]);
        
        for (const entry of entries.rows) {
          const pId = entry.participant_id;
          await client.query(
            `UPDATE wallets SET balance = balance + 2.00, total_used = total_used - 2.00 WHERE participant_id = $1`,
            [pId]
          );
          await client.query(
            `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
             VALUES ($1, $2, 2.00, 'challenge_refund', $3, $4)`,
             [uuidv4(), pId, `Reembolso de cancelamento do desafio: ${matchLabel}`, matchId]
          );
        }

        await client.query('DELETE FROM challenge_prize_distributions WHERE match_id = $1', [matchId]);
        await client.query('DELETE FROM challenge_results WHERE match_id = $1', [matchId]);

        await client.query(
          `INSERT INTO challenge_matches (match_id, status) VALUES ($1, 'cancelled')
           ON CONFLICT (match_id) DO UPDATE SET status = 'cancelled'`,
          [matchId]
        );

        await client.query('COMMIT');
        return res.status(200).json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Cancel challenge error:', e);
        return res.status(500).json({ error: 'Erro ao cancelar desafio: ' + e.message });
      } finally {
        client.release();
      }
    }

    // POST /admin/challenges/:matchId/process (admin only)
    const adminProcessChallenge = url.match(/^\/admin\/challenges\/([^/]+)\/process$/);
    if (adminProcessChallenge && method === 'POST') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const matchId = adminProcessChallenge[1];

      const resultRes = await pool.query('SELECT score1, score2 FROM results WHERE match_id = $1', [matchId]);
      if (!resultRes.rows.length || resultRes.rows[0].score1 === null || resultRes.rows[0].score2 === null) {
        return res.status(400).json({ error: 'A partida ainda não possui resultado final registrado no sistema' });
      }
      const realS1 = parseInt(resultRes.rows[0].score1);
      const realS2 = parseInt(resultRes.rows[0].score2);

      const matches = loadMatches();
      const match = matches.find(m => String(m.id) === String(matchId));
      const matchLabel = match ? `${match.team1} x ${match.team2}` : `Jogo #${matchId}`;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const chCheck = await client.query('SELECT status FROM challenge_matches WHERE match_id = $1 FOR UPDATE', [matchId]);
        if (chCheck.rows.length && chCheck.rows[0].status === 'cancelled') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Este desafio está cancelado e não pode ser processado' });
        }

        const entriesRes = await client.query(
          `SELECT e.id as entry_id, e.participant_id, p.score1, p.score2
           FROM challenge_entries e
           JOIN challenge_predictions p ON e.id = p.entry_id
           WHERE e.match_id = $1`,
          [matchId]
        );
        const entries = entriesRes.rows;
        const count = entries.length;

        if (count === 0) {
          await client.query(
            `INSERT INTO challenge_matches (match_id, status) VALUES ($1, 'processed')
             ON CONFLICT (match_id) DO UPDATE SET status = 'processed'`,
            [matchId]
          );
          await client.query(
            `INSERT INTO challenge_results (match_id, status) VALUES ($1, 'finished') ON CONFLICT (match_id) DO NOTHING`,
            [matchId]
          );
          await client.query('COMMIT');
          return res.status(200).json({ ok: true, message: 'Nenhuma aposta cadastrada para este jogo' });
        }

        if (count < 3) {
          for (const entry of entries) {
            await client.query(
              `UPDATE wallets SET balance = balance + 2.00, total_used = total_used - 2.00 WHERE participant_id = $1`,
              [entry.participant_id]
            );
            await client.query(
              `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
               VALUES ($1, $2, 2.00, 'challenge_refund', $3, $4)`,
               [uuidv4(), entry.participant_id, `Reembolso de cancelamento (mínimo < 3 inscritos): ${matchLabel}`, matchId]
            );
          }

          await client.query(
            `INSERT INTO challenge_matches (match_id, status) VALUES ($1, 'cancelled')
             ON CONFLICT (match_id) DO UPDATE SET status = 'cancelled'`,
            [matchId]
          );
          await client.query('COMMIT');
          return res.status(200).json({ ok: true, cancelled: true, message: 'Desafio cancelado por possuir menos de 3 participantes. Valor estornado.' });
        }

        const brutoPool = count * 2.00;
        const adminFee = brutoPool * 0.10;
        const netoPool = brutoPool - adminFee;

        const exactWinners = [];
        const outcomeWinners = [];
        const sign = (x1, x2) => x1 > x2 ? 1 : x1 < x2 ? -1 : 0;
        const realSign = sign(realS1, realS2);

        entries.forEach(entry => {
          const guessS1 = parseInt(entry.score1);
          const guessS2 = parseInt(entry.score2);
          const isExact = guessS1 === realS1 && guessS2 === realS2;
          const isOutcome = sign(guessS1, guessS2) === realSign;

          if (isExact) exactWinners.push(entry.participant_id);
          if (isOutcome) outcomeWinners.push(entry.participant_id);
        });

        let distributionType = '';
        let winners = [];
        let prizePerWinner = 0;

        if (exactWinners.length > 0) {
          distributionType = 'exact_score';
          winners = exactWinners;
          prizePerWinner = netoPool / exactWinners.length;
        } else if (outcomeWinners.length > 0) {
          distributionType = 'outcome';
          winners = outcomeWinners;
          prizePerWinner = netoPool / outcomeWinners.length;
        } else {
          distributionType = 'refund';
          winners = entries.map(e => e.participant_id);
          prizePerWinner = netoPool / count;
        }

        for (const pId of winners) {
          await client.query(
            `UPDATE wallets SET balance = balance + $1, total_won = total_won + $2 WHERE participant_id = $3`,
            [prizePerWinner, distributionType === 'refund' ? 0.00 : prizePerWinner, pId]
          );

          let desc = '';
          if (distributionType === 'exact_score') {
            desc = `Prêmio do Desafio (Placar Exato): ${matchLabel}`;
          } else if (distributionType === 'outcome') {
            desc = `Prêmio do Desafio (Vencedor/Empate): ${matchLabel}`;
          } else {
            desc = `Devolução proporcional do pool líquido (sem acertadores): ${matchLabel}`;
          }

          const distId = uuidv4();
          await client.query(
            `INSERT INTO challenge_prize_distributions (id, match_id, participant_id, amount, type)
             VALUES ($1, $2, $3, $4, $5)`,
            [distId, matchId, pId, prizePerWinner, distributionType]
          );

          await client.query(
            `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [uuidv4(), pId, prizePerWinner, distributionType === 'refund' ? 'challenge_refund' : 'challenge_prize', desc, matchId]
          );
        }

        await client.query(
          `INSERT INTO challenge_matches (match_id, status) VALUES ($1, 'processed')
           ON CONFLICT (match_id) DO UPDATE SET status = 'processed'`,
          [matchId]
        );

        await client.query(
          `INSERT INTO challenge_results (match_id, status) VALUES ($1, 'finished')
           ON CONFLICT (match_id) DO UPDATE SET status = 'finished'`,
          [matchId]
        );

        await client.query('COMMIT');
        return res.status(200).json({
          ok: true,
          count,
          brutoPool,
          netoPool,
          winnersCount: winners.length,
          prizePerWinner,
          type: distributionType
        });
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Process challenge error:', e);
        return res.status(500).json({ error: 'Erro ao processar desafio: ' + e.message });
      } finally {
        client.release();
      }
    }

    // POST /admin/challenges/:matchId/recalculate (admin only)
    const adminRecalculateChallenge = url.match(/^\/admin\/challenges\/([^/]+)\/recalculate$/);
    if (adminRecalculateChallenge && method === 'POST') {
      const adminPin = await getAdminPin();
      if (String(req.headers['x-admin-pin']) !== adminPin)
        return res.status(401).json({ error: 'PIN de admin incorreto' });

      const matchId = adminRecalculateChallenge[1];

      const resultRes = await pool.query('SELECT score1, score2 FROM results WHERE match_id = $1', [matchId]);
      if (!resultRes.rows.length || resultRes.rows[0].score1 === null || resultRes.rows[0].score2 === null) {
        return res.status(400).json({ error: 'A partida ainda não possui resultado final registrado no sistema' });
      }
      const realS1 = parseInt(resultRes.rows[0].score1);
      const realS2 = parseInt(resultRes.rows[0].score2);

      const matches = loadMatches();
      const match = matches.find(m => String(m.id) === String(matchId));
      const matchLabel = match ? `${match.team1} x ${match.team2}` : `Jogo #${matchId}`;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const chCheck = await client.query('SELECT status FROM challenge_matches WHERE match_id = $1 FOR UPDATE', [matchId]);
        if (!chCheck.rows.length || chCheck.rows[0].status !== 'processed') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Este desafio ainda não foi processado' });
        }

        const dists = await client.query('SELECT participant_id, amount, type FROM challenge_prize_distributions WHERE match_id = $1', [matchId]);
        for (const dist of dists.rows) {
          const pId = dist.participant_id;
          const amt = parseFloat(dist.amount);

          await client.query(
            `UPDATE wallets SET balance = balance - $1, total_won = total_won - $2 WHERE participant_id = $3`,
            [amt, dist.type === 'refund' ? 0.00 : amt, pId]
          );

          await client.query(
            `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
             VALUES ($1, $2, $3, 'challenge_rollback', $4, $5)`,
             [uuidv4(), pId, -amt, `Estorno por recalculo de premiação: ${matchLabel}`, matchId]
          );
        }

        await client.query('DELETE FROM challenge_prize_distributions WHERE match_id = $1', [matchId]);
        await client.query('DELETE FROM challenge_results WHERE match_id = $1', [matchId]);

        const entriesRes = await client.query(
          `SELECT e.id as entry_id, e.participant_id, p.score1, p.score2
           FROM challenge_entries e
           JOIN challenge_predictions p ON e.id = p.entry_id
           WHERE e.match_id = $1`,
          [matchId]
        );
        const entries = entriesRes.rows;
        const count = entries.length;

        if (count === 0) {
          await client.query(`UPDATE challenge_matches SET status = 'processed' WHERE match_id = $1`, [matchId]);
          await client.query('COMMIT');
          return res.status(200).json({ ok: true, message: 'Processado sem palpites' });
        }

        if (count < 3) {
          for (const entry of entries) {
            await client.query(
              `UPDATE wallets SET balance = balance + 2.00, total_used = total_used - 2.00 WHERE participant_id = $1`,
              [entry.participant_id]
            );
            await client.query(
              `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
               VALUES ($1, $2, 2.00, 'challenge_refund', $3, $4)`,
               [uuidv4(), entry.participant_id, `Reembolso de cancelamento (mínimo < 3 inscritos): ${matchLabel}`, matchId]
            );
          }
          await client.query(`UPDATE challenge_matches SET status = 'cancelled' WHERE match_id = $1`, [matchId]);
          await client.query('COMMIT');
          return res.status(200).json({ ok: true, message: 'Desafio cancelado por possuir menos de 3 participantes.' });
        }

        const brutoPool = count * 2.00;
        const adminFee = brutoPool * 0.10;
        const netoPool = brutoPool - adminFee;

        const exactWinners = [];
        const outcomeWinners = [];
        const sign = (x1, x2) => x1 > x2 ? 1 : x1 < x2 ? -1 : 0;
        const realSign = sign(realS1, realS2);

        entries.forEach(entry => {
          const guessS1 = parseInt(entry.score1);
          const guessS2 = parseInt(entry.score2);
          const isExact = guessS1 === realS1 && guessS2 === realS2;
          const isOutcome = sign(guessS1, guessS2) === realSign;
          if (isExact) exactWinners.push(entry.participant_id);
          if (isOutcome) outcomeWinners.push(entry.participant_id);
        });

        let distributionType = '';
        let winners = [];
        let prizePerWinner = 0;

        if (exactWinners.length > 0) {
          distributionType = 'exact_score';
          winners = exactWinners;
          prizePerWinner = netoPool / exactWinners.length;
        } else if (outcomeWinners.length > 0) {
          distributionType = 'outcome';
          winners = outcomeWinners;
          prizePerWinner = netoPool / outcomeWinners.length;
        } else {
          distributionType = 'refund';
          winners = entries.map(e => e.participant_id);
          prizePerWinner = netoPool / count;
        }

        for (const pId of winners) {
          await client.query(
            `UPDATE wallets SET balance = balance + $1, total_won = total_won + $2 WHERE participant_id = $3`,
            [prizePerWinner, distributionType === 'refund' ? 0.00 : prizePerWinner, pId]
          );

          let desc = '';
          if (distributionType === 'exact_score') {
            desc = `Prêmio do Desafio (Placar Exato): ${matchLabel}`;
          } else if (distributionType === 'outcome') {
            desc = `Prêmio do Desafio (Vencedor/Empate): ${matchLabel}`;
          } else {
            desc = `Devolução proporcional do pool líquido (sem acertadores): ${matchLabel}`;
          }

          await client.query(
            `INSERT INTO challenge_prize_distributions (id, match_id, participant_id, amount, type)
             VALUES ($1, $2, $3, $4, $5)`,
            [uuidv4(), matchId, pId, prizePerWinner, distributionType]
          );

          await client.query(
            `INSERT INTO wallet_transactions (id, participant_id, amount, type, description, reference_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [uuidv4(), pId, prizePerWinner, distributionType === 'refund' ? 'challenge_refund' : 'challenge_prize', desc, matchId]
          );
        }

        await client.query(`UPDATE challenge_matches SET status = 'processed' WHERE match_id = $1`, [matchId]);
        await client.query(
          `INSERT INTO challenge_results (match_id, status) VALUES ($1, 'finished')
           ON CONFLICT (match_id) DO UPDATE SET status = 'finished'`,
          [matchId]
        );

        await client.query('COMMIT');
        return res.status(200).json({
          ok: true,
          count,
          brutoPool,
          netoPool,
          winnersCount: winners.length,
          prizePerWinner,
          type: distributionType
        });
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('Recalculate challenge error:', e);
        return res.status(500).json({ error: 'Erro ao recalcular desafio: ' + e.message });
      } finally {
        client.release();
      }
    }

    return res.status(404).json({ error: 'Rota não encontrada: ' + url });

  } catch (e) {
    console.error('handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
