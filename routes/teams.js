const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

/**
 * GET /api/teams/:teamId
 * Get team details with roster
 */
router.get('/:teamId', async (req, res) => {
  try {
    const { teamId } = req.params;

    // Get team info
    const teamResult = await pool.query(
      `SELECT t.*, l.salary_cap, l.name as league_name, l.sport
       FROM teams t
       JOIN leagues l ON t.league_id = l.id
       WHERE t.id = $1`,
      [teamId]
    );

    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const team = teamResult.rows[0];

    // Get roster
    const rosterResult = await pool.query(
      `SELECT p.*, tr.contract_years, tr.contract_salary
       FROM players p
       JOIN team_rosters tr ON p.id = tr.player_id
       WHERE tr.team_id = $1 AND tr.is_free_agent = false
       ORDER BY p.overall_rating DESC`,
      [teamId]
    );

    // Get current season stats for each player
    const roster = await Promise.all(rosterResult.rows.map(async (player) => {
      const statsResult = await pool.query(
        `SELECT stats, games_played FROM player_stats 
         WHERE player_id = $1 AND league_id = $2 
         ORDER BY season DESC LIMIT 1`,
        [player.id, team.league_id]
      );

      return {
        ...player,
        stats: statsResult.rows[0]?.stats || null,
        games_played: statsResult.rows[0]?.games_played || 0
      };
    }));

    res.json({
      ...team,
      roster,
      cap_space: team.salary_cap - team.total_salary
    });
  } catch (error) {
    console.error('Error fetching team:', error);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

/**
 * GET /api/teams/league/:leagueId
 * Get all teams in a league with standings
 */
router.get('/league/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;

    const result = await pool.query(
      `SELECT t.*, 
              (t.wins::float / NULLIF(t.wins + t.losses, 0)) as win_percentage,
              COUNT(tr.id) as roster_size
       FROM teams t
       LEFT JOIN team_rosters tr ON t.id = tr.team_id AND tr.is_free_agent = false
       WHERE t.league_id = $1
       GROUP BY t.id
       ORDER BY win_percentage DESC NULLS LAST, t.wins DESC`,
      [leagueId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

/**
 * POST /api/teams
 * Create a new team
 */
router.post('/', async (req, res) => {
  try {
    const { leagueId, userId, name, abbreviation } = req.body;

    // Check if user already has a team in this league
    const existingTeam = await pool.query(
      'SELECT * FROM teams WHERE league_id = $1 AND user_id = $2',
      [leagueId, userId]
    );

    if (existingTeam.rows.length > 0) {
      return res.status(400).json({ error: 'User already has a team in this league' });
    }

    const result = await pool.query(
      `INSERT INTO teams (league_id, user_id, name, abbreviation)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [leagueId, userId, name, abbreviation]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating team:', error);
    res.status(500).json({ error: 'Failed to create team' });
  }
});

/**
 * PUT /api/teams/:teamId
 * Update team details
 */
router.put('/:teamId', async (req, res) => {
  try {
    const { teamId } = req.params;
    const { name, abbreviation } = req.body;

    const result = await pool.query(
      `UPDATE teams SET name = $1, abbreviation = $2 WHERE id = $3 RETURNING *`,
      [name, abbreviation, teamId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating team:', error);
    res.status(500).json({ error: 'Failed to update team' });
  }
});

/**
 * GET /api/teams/:teamId/schedule
 * Get team's game schedule
 */
router.get('/:teamId/schedule', async (req, res) => {
  try {
    const { teamId } = req.params;
    const { season } = req.query;

    let query = `
      SELECT g.*, 
             ht.name as home_team_name, ht.abbreviation as home_team_abbr,
             at.name as away_team_name, at.abbreviation as away_team_abbr
      FROM games g
      JOIN teams ht ON g.home_team_id = ht.id
      JOIN teams at ON g.away_team_id = at.id
      WHERE (g.home_team_id = $1 OR g.away_team_id = $1)
    `;

    const params = [teamId];

    if (season) {
      query += ' AND g.season = $2';
      params.push(season);
    }

    query += ' ORDER BY g.season, g.day';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching schedule:', error);
    res.status(500).json({ error: 'Failed to fetch schedule' });
  }
});

/**
 * GET /api/teams/:teamId/stats
 * Get team statistics
 */
router.get('/:teamId/stats', async (req, res) => {
  try {
    const { teamId } = req.params;
    const { season } = req.query;

    // Get team info
    const teamResult = await pool.query(
      'SELECT * FROM teams WHERE id = $1',
      [teamId]
    );

    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const team = teamResult.rows[0];

    // Get roster with stats
    let statsQuery = `
      SELECT p.id, p.name, p.position, p.overall_rating,
             ps.stats, ps.games_played
      FROM players p
      JOIN team_rosters tr ON p.id = tr.player_id
      JOIN player_stats ps ON p.id = ps.player_id AND ps.league_id = tr.league_id
      WHERE tr.team_id = $1 AND tr.is_free_agent = false
    `;

    const params = [teamId];

    if (season) {
      statsQuery += ' AND ps.season = $2';
      params.push(season);
    } else {
      statsQuery += ' ORDER BY ps.season DESC';
    }

    const statsResult = await pool.query(statsQuery, params);

    // Calculate team averages
    const teamStats = calculateTeamStats(statsResult.rows, team);

    res.json({
      team,
      playerStats: statsResult.rows,
      teamAverages: teamStats
    });
  } catch (error) {
    console.error('Error fetching team stats:', error);
    res.status(500).json({ error: 'Failed to fetch team stats' });
  }
});

/**
 * DELETE /api/teams/:teamId/players/:playerId
 * Release a player from the team (make them a free agent)
 */
router.delete('/:teamId/players/:playerId', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { teamId, playerId } = req.params;

    // Get team's league
    const teamResult = await client.query(
      'SELECT league_id FROM teams WHERE id = $1',
      [teamId]
    );

    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const leagueId = teamResult.rows[0].league_id;

    // Release the player
    await client.query(
      `UPDATE team_rosters 
       SET is_free_agent = true, team_id = NULL 
       WHERE player_id = $1 AND league_id = $2 AND team_id = $3`,
      [playerId, leagueId, teamId]
    );

    // Update team salary
    await client.query(
      `UPDATE teams 
       SET total_salary = (
         SELECT COALESCE(SUM(contract_salary), 0)
         FROM team_rosters
         WHERE team_id = $1 AND is_free_agent = false
       )
       WHERE id = $1`,
      [teamId]
    );

    await client.query('COMMIT');

    res.json({ message: 'Player released successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error releasing player:', error);
    res.status(500).json({ error: 'Failed to release player' });
  } finally {
    client.release();
  }
});

/**
 * Helper function to calculate team statistics
 */
function calculateTeamStats(playerStats, team) {
  if (!playerStats || playerStats.length === 0) {
    return null;
  }

  // This is sport-specific - example for NBA
  const stats = {
    ppg: 0,
    apg: 0,
    rpg: 0,
    fg_percentage: 0,
    wins: team.wins,
    losses: team.losses,
    win_percentage: team.wins / (team.wins + team.losses) || 0
  };

  let totalGames = 0;

  playerStats.forEach(player => {
    if (player.stats && player.games_played) {
      const playerAvg = player.stats;
      stats.ppg += (playerAvg.ppg || 0);
      stats.apg += (playerAvg.apg || 0);
      stats.rpg += (playerAvg.rpg || 0);
      stats.fg_percentage += (playerAvg.fg || 0);
      totalGames = Math.max(totalGames, player.games_played);
    }
  });

  if (playerStats.length > 0) {
    stats.fg_percentage /= playerStats.length;
  }

  return stats;
}

module.exports = router;
