const { pool } = require('../database/init');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Initialize a draft for a league
 */
async function initializeDraft(leagueId, draftSettings) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Get all teams in the league
    const teamsResult = await client.query(
      'SELECT * FROM teams WHERE league_id = $1 ORDER BY id',
      [leagueId]
    );

    const teams = teamsResult.rows;

    if (teams.length === 0) {
      throw new Error('No teams in league');
    }

    // Get available players for draft pool
    const playersResult = await client.query(
      `SELECT p.* FROM players p
       WHERE NOT EXISTS (
         SELECT 1 FROM team_rosters tr 
         WHERE tr.player_id = p.id AND tr.league_id = $1
       )
       ORDER BY p.overall_rating DESC
       LIMIT $2`,
      [leagueId, draftSettings.totalPicks || 500]
    );

    // Create draft state
    const draftState = {
      league_id: leagueId,
      status: 'not_started',
      current_pick: 1,
      current_round: 1,
      total_rounds: draftSettings.rounds || 10,
      draft_type: draftSettings.type || 'snake',
      teams: teams.map(t => ({
        id: t.id,
        name: t.name,
        user_id: t.user_id,
        picks: [],
        is_ai: t.user_id === null // AI controls teams without users
      })),
      available_players: playersResult.rows.map(p => p.id),
      draft_order: generateDraftOrder(teams, draftSettings.rounds || 10, draftSettings.type || 'snake'),
      settings: draftSettings,
      created_at: new Date().toISOString()
    };

    // Store draft state in database
    await client.query(
      `INSERT INTO drafts (league_id, status, current_pick, current_round, draft_state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (league_id) 
       DO UPDATE SET status = $2, current_pick = $3, current_round = $4, draft_state = $5`,
      [
        leagueId,
        draftState.status,
        draftState.current_pick,
        draftState.current_round,
        JSON.stringify(draftState)
      ]
    );

    await client.query('COMMIT');

    return draftState;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error initializing draft:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Generate draft order based on draft type
 */
function generateDraftOrder(teams, rounds, draftType) {
  const order = [];
  
  if (draftType === 'snake') {
    for (let round = 1; round <= rounds; round++) {
      if (round % 2 === 1) {
        // Odd rounds: normal order
        teams.forEach((team, index) => {
          order.push({
            pick: order.length + 1,
            round,
            team_id: team.id,
            team_name: team.name
          });
        });
      } else {
        // Even rounds: reverse order
        [...teams].reverse().forEach((team, index) => {
          order.push({
            pick: order.length + 1,
            round,
            team_id: team.id,
            team_name: team.name
          });
        });
      }
    }
  } else {
    // Linear draft
    for (let round = 1; round <= rounds; round++) {
      teams.forEach((team, index) => {
        order.push({
          pick: order.length + 1,
          round,
          team_id: team.id,
          team_name: team.name
        });
      });
    }
  }
  
  return order;
}

/**
 * Start the draft
 */
async function startDraft(leagueId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT draft_state FROM drafts WHERE league_id = $1',
      [leagueId]
    );

    if (result.rows.length === 0) {
      throw new Error('Draft not initialized');
    }

    const draftState = result.rows[0].draft_state;
    draftState.status = 'in_progress';
    draftState.started_at = new Date().toISOString();

    await client.query(
      'UPDATE drafts SET status = $1, draft_state = $2 WHERE league_id = $3',
      ['in_progress', JSON.stringify(draftState), leagueId]
    );

    await client.query('COMMIT');

    return draftState;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error starting draft:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Make a draft pick (human or AI)
 */
async function makeDraftPick(leagueId, teamId, playerId, io) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Get current draft state
    const draftResult = await client.query(
      'SELECT draft_state FROM drafts WHERE league_id = $1',
      [leagueId]
    );

    if (draftResult.rows.length === 0) {
      throw new Error('Draft not found');
    }

    const draftState = draftResult.rows[0].draft_state;

    if (draftState.status !== 'in_progress') {
      throw new Error('Draft is not in progress');
    }

    // Verify it's this team's turn
    const currentPick = draftState.draft_order[draftState.current_pick - 1];
    if (currentPick.team_id !== teamId) {
      throw new Error('Not this team\'s turn to pick');
    }

    // Verify player is available
    if (!draftState.available_players.includes(playerId)) {
      throw new Error('Player not available');
    }

    // Get player details
    const playerResult = await client.query(
      'SELECT * FROM players WHERE id = $1',
      [playerId]
    );

    if (playerResult.rows.length === 0) {
      throw new Error('Player not found');
    }

    const player = playerResult.rows[0];

    // Record the pick
    const team = draftState.teams.find(t => t.id === teamId);
    team.picks.push({
      pick_number: draftState.current_pick,
      round: draftState.current_round,
      player_id: playerId,
      player_name: player.name,
      position: player.position,
      overall_rating: player.overall_rating
    });

    // Remove player from available pool
    draftState.available_players = draftState.available_players.filter(id => id !== playerId);

    // Add player to team roster
    await client.query(
      `INSERT INTO team_rosters (team_id, player_id, league_id, contract_years, contract_salary, is_free_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        teamId,
        playerId,
        leagueId,
        4, // Rookie contracts are typically 4 years
        calculateRookieContract(draftState.current_pick, player.overall_rating),
        false
      ]
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

    // Move to next pick
    draftState.current_pick++;
    
    // Check if we need to move to next round
    if (draftState.current_pick > draftState.teams.length * draftState.current_round) {
      draftState.current_round++;
    }

    // Check if draft is complete
    if (draftState.current_pick > draftState.draft_order.length) {
      draftState.status = 'completed';
      draftState.completed_at = new Date().toISOString();
    }

    // Save updated draft state
    await client.query(
      'UPDATE drafts SET status = $1, current_pick = $2, current_round = $3, draft_state = $4 WHERE league_id = $5',
      [draftState.status, draftState.current_pick, draftState.current_round, JSON.stringify(draftState), leagueId]
    );

    await client.query('COMMIT');

    // Emit WebSocket event
    if (io) {
      io.to(`league_${leagueId}`).emit('draft_pick_made', {
        leagueId,
        pickNumber: draftState.current_pick - 1,
        round: currentPick.round,
        teamId,
        teamName: currentPick.team_name,
        playerId,
        playerName: player.name,
        position: player.position,
        overall: player.overall_rating,
        currentPick: draftState.current_pick,
        status: draftState.status
      });
    }

    return {
      draftState,
      pick: {
        pickNumber: draftState.current_pick - 1,
        player
      }
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error making draft pick:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * AI makes a draft pick
 */
async function makeAIDraftPick(leagueId, teamId, io) {
  const client = await pool.connect();
  
  try {
    // Get draft state
    const draftResult = await client.query(
      'SELECT draft_state FROM drafts WHERE league_id = $1',
      [leagueId]
    );

    const draftState = draftResult.rows[0].draft_state;
    const team = draftState.teams.find(t => t.id === teamId);

    // Get team's current roster positions
    const rosterResult = await client.query(
      `SELECT p.position, COUNT(*) as count
       FROM team_rosters tr
       JOIN players p ON tr.player_id = p.id
       WHERE tr.team_id = $1 AND tr.league_id = $2
       GROUP BY p.position`,
      [teamId, leagueId]
    );

    const positionCounts = {};
    rosterResult.rows.forEach(row => {
      positionCounts[row.position] = parseInt(row.count);
    });

    // Get available players
    const playersResult = await client.query(
      `SELECT * FROM players 
       WHERE id = ANY($1)
       ORDER BY overall_rating DESC
       LIMIT 20`,
      [draftState.available_players]
    );

    const availablePlayers = playersResult.rows;

    // Use AI to make intelligent pick
    const selectedPlayer = await selectBestPlayer(
      team,
      availablePlayers,
      positionCounts,
      draftState.current_pick,
      draftState.current_round
    );

    // Make the pick
    return await makeDraftPick(leagueId, teamId, selectedPlayer.id, io);
  } catch (error) {
    console.error('Error making AI draft pick:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * AI selects best available player based on team needs
 */
async function selectBestPlayer(team, availablePlayers, positionCounts, pickNumber, round) {
  try {
    const prompt = `You are an NBA GM making a draft pick. Analyze the available players and team needs.

Team: ${team.name}
Current Pick: Round ${round}, Pick ${pickNumber}
Current Roster Composition: ${JSON.stringify(positionCounts)}

Available Players (top 20 by rating):
${availablePlayers.map((p, i) => `${i + 1}. ${p.name} - ${p.position}, Overall: ${p.overall_rating}, Potential: ${p.potential}`).join('\n')}

Choose the best player considering:
1. Best Player Available (BPA) - overall talent level
2. Team Needs - fill position gaps
3. Potential - especially important in later rounds
4. Position value - PG, wings, and centers have different strategic value

Return ONLY a JSON object with this exact format:
{
  "playerId": <the id of the selected player>,
  "reason": "brief 1-2 sentence explanation"
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    let jsonText = responseText;
    
    if (responseText.includes('```json')) {
      jsonText = responseText.match(/```json\n([\s\S]*?)\n```/)?.[1] || responseText;
    } else if (responseText.includes('```')) {
      jsonText = responseText.match(/```\n([\s\S]*?)\n```/)?.[1] || responseText;
    }
    
    const decision = JSON.parse(jsonText.trim());
    
    const selectedPlayer = availablePlayers.find(p => p.id === decision.playerId);
    
    if (!selectedPlayer) {
      // Fallback: pick highest rated player
      return availablePlayers[0];
    }

    console.log(`AI Pick - ${team.name}: ${selectedPlayer.name} (${selectedPlayer.position}) - ${decision.reason}`);
    
    return selectedPlayer;
  } catch (error) {
    console.error('Error in AI player selection:', error);
    // Fallback: pick highest rated available player
    return availablePlayers[0];
  }
}

/**
 * Calculate rookie contract based on draft position
 */
function calculateRookieContract(pickNumber, overall) {
  // NBA rookie scale contracts (simplified)
  const baseContracts = {
    1: 10000000,
    2: 9000000,
    3: 8000000,
    4: 7000000,
    5: 6500000,
    10: 5000000,
    15: 3500000,
    20: 2500000,
    30: 2000000,
    40: 1500000,
    50: 1200000,
    60: 1000000
  };

  // Find appropriate contract tier
  let salary = 1000000; // Minimum
  
  for (const [pick, amount] of Object.entries(baseContracts)) {
    if (pickNumber <= parseInt(pick)) {
      salary = amount;
      break;
    }
  }

  // Adjust slightly based on overall rating
  const ratingMultiplier = overall / 80;
  salary = Math.floor(salary * ratingMultiplier);

  return salary;
}

/**
 * Auto-draft for AI teams
 */
async function processAIDrafts(leagueId, io) {
  const client = await pool.connect();
  
  try {
    const draftResult = await client.query(
      'SELECT draft_state FROM drafts WHERE league_id = $1',
      [leagueId]
    );

    if (draftResult.rows.length === 0) {
      return;
    }

    const draftState = draftResult.rows[0].draft_state;

    if (draftState.status !== 'in_progress') {
      return;
    }

    // Get current pick
    const currentPick = draftState.draft_order[draftState.current_pick - 1];
    const team = draftState.teams.find(t => t.id === currentPick.team_id);

    // Check if it's an AI team's turn
    if (team && team.is_ai) {
      console.log(`AI team ${team.name} is picking...`);
      
      // Add slight delay for realism
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await makeAIDraftPick(leagueId, team.id, io);
      
      // Continue processing if next pick is also AI
      // This creates a recursive chain until a human team's turn
      setTimeout(() => processAIDrafts(leagueId, io), 1000);
    }
  } catch (error) {
    console.error('Error processing AI drafts:', error);
  } finally {
    client.release();
  }
}

/**
 * Get draft state
 */
async function getDraftState(leagueId) {
  const result = await pool.query(
    'SELECT draft_state FROM drafts WHERE league_id = $1',
    [leagueId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].draft_state;
}

module.exports = {
  initializeDraft,
  startDraft,
  makeDraftPick,
  makeAIDraftPick,
  processAIDrafts,
  getDraftState,
  generateDraftOrder
};
