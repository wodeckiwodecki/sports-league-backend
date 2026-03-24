/**
 * seed-nba-players.js
 * Seeds NBA players from the Basketball GM 2024-25 roster JSON.
 * Source: https://github.com/alexnoob/BasketBall-GM-Rosters
 *
 * Usage (local): DB_HOST=... DB_USER=... DB_PASSWORD=... node scripts/seed-nba-players.js
 * Usage (Railway): Triggered via POST /api/admin/seed-nba-players
 */

const https = require('https');
const { pool } = require('../database/init');

const ROSTER_URL = 'https://raw.githubusercontent.com/alexnoob/BasketBall-GM-Rosters/master/2024-25.NBA.Roster.json';

// Map Basketball GM positions to our standard positions
function normalizePosition(pos) {
  const map = {
    'PG': 'PG', 'SG': 'SG', 'SF': 'SF', 'PF': 'PF', 'C': 'C',
    'G': 'SG', 'F': 'SF', 'FC': 'PF', 'GF': 'SF', 'PF-C': 'PF',
    'SF-SG': 'SF', 'PG-SG': 'PG'
  };
  return map[pos] || 'SF';
}

// Calculate overall rating from Basketball GM skill ratings
// Basketball GM ratings typically range 20-90 for elite players
function calculateOverall(ratings) {
  if (!ratings) return 65;
  const { ins = 40, fg = 40, tp = 40, diq = 40, oiq = 40, spd = 40, reb = 40, pss = 40, dnk = 40, ft = 40 } = ratings;
  // Weighted composite of key attributes
  const raw = (ins * 0.12) + (fg * 0.14) + (tp * 0.08) + (diq * 0.14) +
              (oiq * 0.14) + (spd * 0.08) + (reb * 0.10) + (pss * 0.10) +
              (dnk * 0.06) + (ft * 0.04);
  // Basketball GM elite players score ~65-80 on this weighted avg
  // Map: raw 40 → OVR 60, raw 65 → OVR 85, raw 80+ → OVR 99
  const normalized = Math.round(60 + ((raw - 40) / 40) * 39);
  return Math.min(99, Math.max(55, normalized));
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function seedNBAPlayers() {
  console.log('Fetching 2024-25 NBA roster from Basketball GM...');
  const data = await fetchJSON(ROSTER_URL);
  const players = data.players || [];
  console.log(`Fetched ${players.length} players`);

  // Build team tid -> name map
  const teamMap = {};
  for (const t of (data.teams || [])) {
    teamMap[t.tid] = `${t.region} ${t.name}`;
  }

  const client = await pool.connect();
  let inserted = 0, updated = 0, skipped = 0;

  try {
    await client.query('BEGIN');

    for (const player of players) {
      if (!player.name) { skipped++; continue; }

      const ratings = player.ratings
        ? [...player.ratings].sort((a, b) => b.season - a.season)[0]
        : null;

      const overall = calculateOverall(ratings);
      const position = normalizePosition(player.pos);
      const age = player.born?.year ? (2025 - player.born.year) : Math.floor(Math.random() * 13) + 22;
      const potential = ratings
        ? Math.min(99, Math.max(overall, calculateOverall({ ...ratings, ...Object.fromEntries(Object.entries(ratings).map(([k,v]) => [k, Math.min(100, v + (age < 25 ? 10 : age < 28 ? 5 : 0))])) })))
        : overall;

      const teamName = teamMap[player.tid] || null;

      const attributes = {
        source: 'basketball-gm-2024-25',
        hgt: player.hgt,
        weight: player.weight,
        college: player.college,
        team: teamName,
        ratings: ratings
      };

      const existing = await client.query(
        'SELECT id FROM players WHERE name = $1 AND sport = $2',
        [player.name, 'NBA']
      );

      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE players SET position=$1, overall_rating=$2, potential=$3, age=$4, attributes=$5
           WHERE name=$6 AND sport='NBA'`,
          [position, overall, potential, age, JSON.stringify(attributes), player.name]
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO players (name, position, age, overall_rating, potential, sport, attributes)
           VALUES ($1, $2, $3, $4, $5, 'NBA', $6)`,
          [player.name, position, age, overall, potential, JSON.stringify(attributes)]
        );
        inserted++;
      }

      if ((inserted + updated) % 100 === 0) {
        console.log(`Progress: ${inserted} inserted, ${updated} updated...`);
      }
    }

    await client.query('COMMIT');
    console.log(`Done: ${inserted} inserted, ${updated} updated, ${skipped} skipped`);
    return { inserted, updated, skipped, total: players.length };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Allow direct execution
if (require.main === module) {
  seedNBAPlayers()
    .then(result => { console.log('Seed complete:', result); process.exit(0); })
    .catch(err => { console.error('Seed failed:', err); process.exit(1); });
}

module.exports = { seedNBAPlayers };
