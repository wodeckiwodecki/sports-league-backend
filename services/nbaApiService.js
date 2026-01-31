const axios = require('axios');
const { pool } = require('../database/init');

const NBA_API_BASE = 'https://api.balldontlie.io/v1';

/**
 * Fetch players from NBA API with pagination
 */
async function fetchNBAPlayers(page = 1, perPage = 100) {
  try {
    const response = await axios.get(`${NBA_API_BASE}/players`, {
      params: {
        page,
        per_page: perPage
      }
    });

    return {
      players: response.data.data,
      meta: response.data.meta
    };
  } catch (error) {
    console.error('Error fetching NBA players:', error.message);
    throw error;
  }
}

/**
 * Fetch all NBA players (handles pagination)
 */
async function fetchAllNBAPlayers() {
  const allPlayers = [];
  let currentPage = 1;
  let hasMore = true;

  while (hasMore) {
    const { players, meta } = await fetchNBAPlayers(currentPage, 100);
    allPlayers.push(...players);
    
    console.log(`Fetched page ${currentPage}, total players: ${allPlayers.length}`);
    
    hasMore = meta.next_page !== null;
    currentPage++;
    
    // Add delay to respect rate limits
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return allPlayers;
}

/**
 * Fetch player season averages
 */
async function fetchPlayerSeasonAverages(playerId, season = 2023) {
  try {
    const response = await axios.get(`${NBA_API_BASE}/season_averages`, {
      params: {
        player_ids: [playerId],
        season
      }
    });

    return response.data.data[0] || null;
  } catch (error) {
    console.error(`Error fetching stats for player ${playerId}:`, error.message);
    return null;
  }
}

/**
 * Convert NBA position to our standard format
 */
function normalizePosition(position) {
  if (!position) return 'F';
  
  const pos = position.toUpperCase();
  
  // Handle combined positions
  if (pos.includes('-')) {
    return pos.split('-')[0];
  }
  
  // Map to standard positions
  const positionMap = {
    'G': 'SG',
    'F': 'SF',
    'C': 'C'
  };
  
  return positionMap[pos] || pos;
}

/**
 * Calculate overall rating based on stats
 */
function calculateOverallRating(stats, playerData) {
  if (!stats) {
    // For players without recent stats, use a base rating
    return Math.floor(Math.random() * 15) + 65; // 65-80 range
  }

  // Weight different stats for overall rating
  const ppgWeight = stats.pts * 1.5;
  const rpgWeight = stats.reb * 2.0;
  const apgWeight = stats.ast * 2.5;
  const fgWeight = (stats.fg_pct || 0.4) * 30;
  const efficiencyWeight = ((stats.stl || 0) + (stats.blk || 0)) * 3;
  
  let rating = (ppgWeight + rpgWeight + apgWeight + fgWeight + efficiencyWeight) / 2;
  
  // Normalize to 60-99 range
  rating = Math.min(99, Math.max(60, Math.floor(rating)));
  
  return rating;
}

/**
 * Import NBA players into database
 */
async function importNBAPlayers() {
  const client = await pool.connect();
  
  try {
    console.log('Fetching NBA players from API...');
    const nbaPlayers = await fetchAllNBAPlayers();
    console.log(`Fetched ${nbaPlayers.length} players`);

    await client.query('BEGIN');

    let imported = 0;
    let skipped = 0;

    for (const player of nbaPlayers) {
      try {
        // Skip players without proper data
        if (!player.first_name || !player.last_name) {
          skipped++;
          continue;
        }

        const fullName = `${player.first_name} ${player.last_name}`;
        const position = normalizePosition(player.position);
        
        // Fetch recent stats to calculate rating
        const stats = await fetchPlayerSeasonAverages(player.id, 2023);
        await new Promise(resolve => setTimeout(resolve, 100)); // Rate limiting
        
        const overallRating = calculateOverallRating(stats, player);
        
        // Calculate potential (younger players have higher potential)
        const age = calculateAge(player);
        const potential = calculatePotential(overallRating, age);

        // Check if player already exists
        const existingPlayer = await client.query(
          'SELECT id FROM players WHERE name = $1',
          [fullName]
        );

        if (existingPlayer.rows.length > 0) {
          // Update existing player
          await client.query(
            `UPDATE players 
             SET position = $1, overall_rating = $2, potential = $3, 
                 attributes = $4
             WHERE name = $5`,
            [
              position,
              overallRating,
              potential,
              JSON.stringify({
                nba_api_id: player.id,
                height: player.height,
                weight: player.weight,
                team: player.team?.full_name,
                jersey: player.jersey_number,
                stats: stats
              }),
              fullName
            ]
          );
        } else {
          // Insert new player
          await client.query(
            `INSERT INTO players 
             (name, position, age, overall_rating, potential, draft_year, draft_class, attributes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              fullName,
              position,
              age,
              overallRating,
              potential,
              null, // We don't have draft year from this API
              null,
              JSON.stringify({
                nba_api_id: player.id,
                height: player.height,
                weight: player.weight,
                team: player.team?.full_name,
                jersey: player.jersey_number,
                stats: stats
              })
            ]
          );
        }

        imported++;

        if (imported % 100 === 0) {
          console.log(`Imported ${imported} players...`);
        }

      } catch (error) {
        console.error(`Error importing player ${player.first_name} ${player.last_name}:`, error.message);
        skipped++;
      }
    }

    await client.query('COMMIT');

    console.log(`Import complete: ${imported} imported, ${skipped} skipped`);
    return { imported, skipped, total: nbaPlayers.length };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error importing NBA players:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Calculate player age (estimate based on draft patterns)
 */
function calculateAge(player) {
  // Since API doesn't provide age, estimate based on typical NBA player age
  // Most NBA players are between 22-35
  return Math.floor(Math.random() * 13) + 22;
}

/**
 * Calculate potential based on current rating and age
 */
function calculatePotential(overall, age) {
  if (age <= 23) {
    // Young players: high ceiling
    return Math.min(99, overall + Math.floor(Math.random() * 15) + 5);
  } else if (age <= 27) {
    // Prime years: some growth potential
    return Math.min(99, overall + Math.floor(Math.random() * 8));
  } else if (age <= 30) {
    // Peak: slight upside
    return Math.min(99, overall + Math.floor(Math.random() * 3));
  } else {
    // Veterans: at or past peak
    return overall;
  }
}

/**
 * Search NBA players by name or team
 */
async function searchNBAPlayers(searchTerm) {
  try {
    const response = await axios.get(`${NBA_API_BASE}/players`, {
      params: {
        search: searchTerm
      }
    });

    return response.data.data;
  } catch (error) {
    console.error('Error searching NBA players:', error.message);
    throw error;
  }
}

/**
 * Get players by team
 */
async function getPlayersByTeam(teamId) {
  try {
    const response = await axios.get(`${NBA_API_BASE}/players`, {
      params: {
        team_ids: [teamId]
      }
    });

    return response.data.data;
  } catch (error) {
    console.error('Error fetching team players:', error.message);
    throw error;
  }
}

module.exports = {
  fetchNBAPlayers,
  fetchAllNBAPlayers,
  fetchPlayerSeasonAverages,
  importNBAPlayers,
  searchNBAPlayers,
  getPlayersByTeam,
  calculateOverallRating,
  normalizePosition
};
