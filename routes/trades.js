const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { evaluateTradeProposal } = require('../services/aiService');
const { emitToTeam } = require('../services/websocketService');

/**
 * GET /api/trades/league/:leagueId
 * Get all trades for a league
 */
router.get('/league/:leagueId', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { status } = req.query;

    let query = `
      SELECT t.*, 
             pt.name as proposing_team_name,
             rt.name as receiving_team_name
      FROM trades t
      JOIN teams pt ON t.proposing_team_id = pt.id
      JOIN teams rt ON t.receiving_team_id = rt.id
      WHERE t.league_id = $1
    `;
    
    const params = [leagueId];

    if (status) {
      query += ' AND t.status = $2';
      params.push(status);
    }

    query += ' ORDER BY t.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trades:', error);
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

/**
 * GET /api/trades/team/:teamId/incoming
 * Get incoming trade proposals for a team
 */
router.get('/team/:teamId/incoming', async (req, res) => {
  try {
    const { teamId } = req.params;

    const result = await pool.query(
      `SELECT t.*, 
              pt.name as proposing_team_name,
              rt.name as receiving_team_name
       FROM trades t
       JOIN teams pt ON t.proposing_team_id = pt.id
       JOIN teams rt ON t.receiving_team_id = rt.id
       WHERE t.receiving_team_id = $1 AND t.status = 'pending'
       ORDER BY t.created_at DESC`,
      [teamId]
    );

    // Get player details for each trade
    const tradesWithPlayers = await Promise.all(result.rows.map(async (trade) => {
      const offeringPlayers = await getPlayersByIds(trade.offering_players);
      const requestingPlayers = await getPlayersByIds(trade.requesting_players);

      return {
        ...trade,
        offering_players: offeringPlayers,
        requesting_players: requestingPlayers
      };
    }));

    res.json(tradesWithPlayers);
  } catch (error) {
    console.error('Error fetching incoming trades:', error);
    res.status(500).json({ error: 'Failed to fetch incoming trades' });
  }
});

/**
 * POST /api/trades
 * Create a new trade proposal
 */
router.post('/', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const {
      leagueId,
      proposingTeamId,
      receivingTeamId,
      offeringPlayerIds,
      requestingPlayerIds,
      message
    } = req.body;

    // Validate that teams exist and are in the same league
    const teamsResult = await client.query(
      'SELECT * FROM teams WHERE id IN ($1, $2) AND league_id = $3',
      [proposingTeamId, receivingTeamId, leagueId]
    );

    if (teamsResult.rows.length !== 2) {
      return res.status(400).json({ error: 'Invalid teams or league' });
    }

    const proposingTeam = teamsResult.rows.find(t => t.id === proposingTeamId);
    const receivingTeam = teamsResult.rows.find(t => t.id === receivingTeamId);

    // Get player details
    const offeringPlayers = await getPlayersWithContracts(client, offeringPlayerIds, leagueId);
    const requestingPlayers = await getPlayersWithContracts(client, requestingPlayerIds, leagueId);

    // Use AI to evaluate the trade
    const evaluation = await evaluateTradeProposal(
      { message },
      proposingTeam,
      receivingTeam,
      offeringPlayers,
      requestingPlayers
    );

    // Create the trade
    const result = await client.query(
      `INSERT INTO trades 
       (league_id, proposing_team_id, receiving_team_id, offering_players, requesting_players, message, ai_evaluation, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        leagueId,
        proposingTeamId,
        receivingTeamId,
        JSON.stringify(offeringPlayerIds),
        JSON.stringify(requestingPlayerIds),
        message,
        JSON.stringify(evaluation),
        'pending'
      ]
    );

    const trade = result.rows[0];

    // Emit WebSocket event to notify receiving team
    const io = req.app.get('io');
    emitToTeam(io, receivingTeamId, 'incoming_trade', {
      tradeId: trade.id,
      fromTeam: proposingTeam.name,
      message,
      evaluation
    });

    res.status(201).json({
      ...trade,
      offering_players: offeringPlayers,
      requesting_players: requestingPlayers,
      evaluation
    });
  } catch (error) {
    console.error('Error creating trade:', error);
    res.status(500).json({ error: 'Failed to create trade' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/trades/:tradeId/accept
 * Accept a trade proposal
 */
router.put('/:tradeId/accept', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { tradeId } = req.params;

    // Get trade details
    const tradeResult = await client.query(
      'SELECT * FROM trades WHERE id = $1',
      [tradeId]
    );

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    const trade = tradeResult.rows[0];

    if (trade.status !== 'pending') {
      return res.status(400).json({ error: 'Trade is not pending' });
    }

    // Transfer players
    const offeringPlayerIds = trade.offering_players;
    const requestingPlayerIds = trade.requesting_players;

    // Move offering players to receiving team
    for (const playerId of offeringPlayerIds) {
      await client.query(
        'UPDATE team_rosters SET team_id = $1 WHERE player_id = $2 AND league_id = $3',
        [trade.receiving_team_id, playerId, trade.league_id]
      );
    }

    // Move requesting players to proposing team
    for (const playerId of requestingPlayerIds) {
      await client.query(
        'UPDATE team_rosters SET team_id = $1 WHERE player_id = $2 AND league_id = $3',
        [trade.proposing_team_id, playerId, trade.league_id]
      );
    }

    // Update team salaries
    await updateTeamSalaries(client, trade.proposing_team_id);
    await updateTeamSalaries(client, trade.receiving_team_id);

    // Mark trade as accepted
    await client.query(
      'UPDATE trades SET status = $1, updated_at = NOW() WHERE id = $2',
      ['accepted', tradeId]
    );

    await client.query('COMMIT');

    // Emit WebSocket events
    const io = req.app.get('io');
    const tradeData = {
      tradeId,
      proposingTeamId: trade.proposing_team_id,
      receivingTeamId: trade.receiving_team_id,
      leagueId: trade.league_id
    };

    emitToTeam(io, trade.proposing_team_id, 'trade_completed', tradeData);
    emitToTeam(io, trade.receiving_team_id, 'trade_completed', tradeData);

    res.json({ message: 'Trade accepted successfully', trade });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error accepting trade:', error);
    res.status(500).json({ error: 'Failed to accept trade' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/trades/:tradeId/decline
 * Decline a trade proposal
 */
router.put('/:tradeId/decline', async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { message } = req.body;

    const result = await pool.query(
      'UPDATE trades SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      ['declined', tradeId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    const trade = result.rows[0];

    // Emit WebSocket event
    const io = req.app.get('io');
    emitToTeam(io, trade.proposing_team_id, 'trade_declined', {
      tradeId,
      message: message || 'Trade proposal declined'
    });

    res.json({ message: 'Trade declined', trade });
  } catch (error) {
    console.error('Error declining trade:', error);
    res.status(500).json({ error: 'Failed to decline trade' });
  }
});

/**
 * Helper function to get players with contract details
 */
async function getPlayersWithContracts(client, playerIds, leagueId) {
  if (!playerIds || playerIds.length === 0) return [];

  const result = await client.query(
    `SELECT p.*, tr.contract_years, tr.contract_salary
     FROM players p
     JOIN team_rosters tr ON p.id = tr.player_id
     WHERE p.id = ANY($1) AND tr.league_id = $2`,
    [playerIds, leagueId]
  );

  return result.rows;
}

/**
 * Helper function to get players by IDs
 */
async function getPlayersByIds(playerIds) {
  if (!playerIds || playerIds.length === 0) return [];

  const result = await pool.query(
    'SELECT * FROM players WHERE id = ANY($1)',
    [playerIds]
  );

  return result.rows;
}

/**
 * Helper function to update team total salary
 */
async function updateTeamSalaries(client, teamId) {
  await client.query(
    `UPDATE teams 
     SET total_salary = (
       SELECT COALESCE(SUM(contract_salary), 0)
       FROM team_rosters
       WHERE team_id = $1
     )
     WHERE id = $1`,
    [teamId]
  );
}

module.exports = router;
