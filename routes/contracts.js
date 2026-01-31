const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { generateContractResponse } = require('../services/aiService');
const { emitToTeam } = require('../services/websocketService');

/**
 * GET /api/contracts/free-agents/:leagueId
 * Get all free agents in a league
 */
router.get('/free-agents/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { position } = req.query;

    let query = `
      SELECT p.*, tr.contract_salary as demanded_salary, tr.contract_years as demanded_years
      FROM players p
      JOIN team_rosters tr ON p.id = tr.player_id
      WHERE tr.league_id = $1 AND tr.is_free_agent = true
    `;

    const params = [leagueId];

    if (position) {
      query += ' AND p.position = $2';
      params.push(position);
    }

    query += ' ORDER BY p.overall_rating DESC';

    const result = await pool.query(query, params);

    // Get recent stats for each player
    const playersWithStats = await Promise.all(result.rows.map(async (player) => {
      const statsResult = await pool.query(
        `SELECT stats FROM player_stats 
         WHERE player_id = $1 AND league_id = $2 
         ORDER BY season DESC LIMIT 1`,
        [player.id, leagueId]
      );

      return {
        ...player,
        stats: statsResult.rows[0]?.stats || null
      };
    }));

    res.json(playersWithStats);
  } catch (error) {
    console.error('Error fetching free agents:', error);
    res.status(500).json({ error: 'Failed to fetch free agents' });
  }
});

/**
 * POST /api/contracts/offer
 * Make a contract offer to a free agent
 */
router.post('/offer', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { teamId, playerId, leagueId, years, annualSalary } = req.body;

    // Get team details
    const teamResult = await client.query(
      `SELECT t.*, l.salary_cap 
       FROM teams t
       JOIN leagues l ON t.league_id = l.id
       WHERE t.id = $1`,
      [teamId]
    );

    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const team = teamResult.rows[0];
    const capSpace = team.salary_cap - team.total_salary;

    // Get player details with current stats
    const playerResult = await client.query(
      `SELECT p.*, ps.stats as current_stats
       FROM players p
       LEFT JOIN player_stats ps ON p.id = ps.player_id AND ps.league_id = $2
       WHERE p.id = $1
       ORDER BY ps.season DESC
       LIMIT 1`,
      [playerId, leagueId]
    );

    if (playerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const player = playerResult.rows[0];

    // Check if player is a free agent
    const rosterResult = await client.query(
      'SELECT * FROM team_rosters WHERE player_id = $1 AND league_id = $2',
      [playerId, leagueId]
    );

    if (rosterResult.rows.length === 0 || !rosterResult.rows[0].is_free_agent) {
      return res.status(400).json({ error: 'Player is not a free agent' });
    }

    // Check salary cap space
    if (annualSalary > capSpace) {
      return res.status(400).json({ error: 'Insufficient cap space' });
    }

    // Generate AI agent response
    const agentResponse = await generateContractResponse(
      player,
      { years, annual_salary: annualSalary },
      {
        teamName: team.name,
        capSpace,
        wins: team.wins,
        losses: team.losses
      }
    );

    // Create contract offer
    const offerResult = await client.query(
      `INSERT INTO contract_offers 
       (team_id, player_id, league_id, years, annual_salary, ai_response, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        teamId,
        playerId,
        leagueId,
        years,
        annualSalary,
        agentResponse.response,
        agentResponse.willAccept ? 'accepted' : 'pending'
      ]
    );

    const offer = offerResult.rows[0];

    // If accepted, sign the player
    if (agentResponse.willAccept) {
      await signPlayer(client, teamId, playerId, leagueId, years, annualSalary);

      // Emit WebSocket event
      const io = req.app.get('io');
      io.to(`league_${leagueId}`).emit('contract_signed', {
        teamId,
        teamName: team.name,
        playerId,
        playerName: player.name,
        years,
        salary: annualSalary
      });
    }

    res.status(201).json({
      offer,
      agentResponse,
      playerName: player.name,
      status: agentResponse.willAccept ? 'signed' : 'pending'
    });
  } catch (error) {
    console.error('Error creating contract offer:', error);
    res.status(500).json({ error: 'Failed to create contract offer' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/contracts/team/:teamId
 * Get all contract offers for a team
 */
router.get('/team/:teamId', async (req, res) => {
  try {
    const { teamId } = req.params;

    const result = await pool.query(
      `SELECT co.*, p.name as player_name, p.position, p.overall_rating
       FROM contract_offers co
       JOIN players p ON co.player_id = p.id
       WHERE co.team_id = $1
       ORDER BY co.created_at DESC`,
      [teamId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching contract offers:', error);
    res.status(500).json({ error: 'Failed to fetch contract offers' });
  }
});

/**
 * PUT /api/contracts/:offerId/accept-counter
 * Accept a counter offer from a player's agent
 */
router.put('/:offerId/accept-counter', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { offerId } = req.params;

    // Get offer details
    const offerResult = await client.query(
      `SELECT co.*, p.name as player_name
       FROM contract_offers co
       JOIN players p ON co.player_id = p.id
       WHERE co.id = $1`,
      [offerId]
    );

    if (offerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    const offer = offerResult.rows[0];

    // Parse AI response for counter offer details
    // In a real implementation, this would come from a structured AI response
    const counterYears = offer.years;
    const counterSalary = offer.annual_salary * 1.15; // Example: 15% higher

    // Sign the player with counter terms
    await signPlayer(
      client,
      offer.team_id,
      offer.player_id,
      offer.league_id,
      counterYears,
      counterSalary
    );

    // Update offer status
    await client.query(
      'UPDATE contract_offers SET status = $1, updated_at = NOW() WHERE id = $2',
      ['accepted', offerId]
    );

    await client.query('COMMIT');

    // Emit WebSocket event
    const io = req.app.get('io');
    const teamResult = await pool.query('SELECT name FROM teams WHERE id = $1', [offer.team_id]);
    
    io.to(`league_${offer.league_id}`).emit('contract_signed', {
      teamId: offer.team_id,
      teamName: teamResult.rows[0].name,
      playerId: offer.player_id,
      playerName: offer.player_name,
      years: counterYears,
      salary: counterSalary
    });

    res.json({
      message: 'Counter offer accepted',
      years: counterYears,
      salary: counterSalary
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error accepting counter offer:', error);
    res.status(500).json({ error: 'Failed to accept counter offer' });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/contracts/:offerId
 * Withdraw a contract offer
 */
router.delete('/:offerId', async (req, res) => {
  try {
    const { offerId } = req.params;

    const result = await pool.query(
      'UPDATE contract_offers SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      ['withdrawn', offerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    res.json({ message: 'Offer withdrawn', offer: result.rows[0] });
  } catch (error) {
    console.error('Error withdrawing offer:', error);
    res.status(500).json({ error: 'Failed to withdraw offer' });
  }
});

/**
 * GET /api/contracts/expiring/:leagueId
 * Get players with expiring contracts
 */
router.get('/expiring/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { teamId } = req.query;

    let query = `
      SELECT p.*, tr.contract_years, tr.contract_salary, tr.team_id, t.name as team_name
      FROM players p
      JOIN team_rosters tr ON p.id = tr.player_id
      JOIN teams t ON tr.team_id = t.id
      WHERE tr.league_id = $1 AND tr.contract_years <= 1 AND tr.is_free_agent = false
    `;

    const params = [leagueId];

    if (teamId) {
      query += ' AND tr.team_id = $2';
      params.push(teamId);
    }

    query += ' ORDER BY tr.contract_years ASC, p.overall_rating DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching expiring contracts:', error);
    res.status(500).json({ error: 'Failed to fetch expiring contracts' });
  }
});

/**
 * Helper function to sign a player to a team
 */
async function signPlayer(client, teamId, playerId, leagueId, years, annualSalary) {
  // Update roster entry
  await client.query(
    `UPDATE team_rosters 
     SET team_id = $1, contract_years = $2, contract_salary = $3, is_free_agent = false
     WHERE player_id = $4 AND league_id = $5`,
    [teamId, years, annualSalary, playerId, leagueId]
  );

  // Update team total salary
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
}

module.exports = router;
