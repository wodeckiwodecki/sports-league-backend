const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');

// Middleware to verify authentication
const authenticate = require('../middleware/authenticate');

/**
 * Send league invitation
 * POST /api/invitations/send
 */
router.post('/send', authenticate, async (req, res) => {
  const { leagueId, inviteeEmail } = req.body;
  const inviterId = req.user.id;
  
  try {
    // Verify user is commissioner of this league
    const leagueResult = await pool.query(
      'SELECT commissioner_user_id FROM leagues WHERE id = $1',
      [leagueId]
    );
    
    if (!leagueResult.rows.length) {
      return res.status(404).json({ error: 'League not found' });
    }
    
    if (leagueResult.rows[0].commissioner_user_id !== inviterId) {
      return res.status(403).json({ error: 'Only the commissioner can send invitations' });
    }
    
    // Check if invitation already exists
    const existingInvite = await pool.query(
      'SELECT id FROM league_invitations WHERE league_id = $1 AND invitee_email = $2',
      [leagueId, inviteeEmail]
    );
    
    if (existingInvite.rows.length) {
      return res.status(400).json({ error: 'Invitation already sent to this email' });
    }
    
    // Check if user with this email exists
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [inviteeEmail]
    );
    
    const inviteeUserId = userResult.rows.length ? userResult.rows[0].id : null;
    
    // Create invitation
    const result = await pool.query(
      `INSERT INTO league_invitations (league_id, inviter_id, invitee_email, invitee_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [leagueId, inviterId, inviteeEmail, inviteeUserId]
    );
    
    // Create notification if user exists
    if (inviteeUserId) {
      await pool.query(
        `INSERT INTO notifications (user_id, league_id, notification_type, title, message)
         VALUES ($1, $2, 'league_invitation', 'League Invitation', 'You have been invited to join a league')`,
        [inviteeUserId, leagueId]
      );
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error sending invitation:', error);
    res.status(500).json({ error: 'Failed to send invitation' });
  }
});

/**
 * Get invitations for current user
 * GET /api/invitations/my-invitations
 */
router.get('/my-invitations', authenticate, async (req, res) => {
  const userId = req.user.id;
  
  try {
    const result = await pool.query(
      `SELECT 
        i.*,
        l.name as league_name,
        l.sport,
        u.username as inviter_username
       FROM league_invitations i
       JOIN leagues l ON i.league_id = l.id
       JOIN users u ON i.inviter_id = u.id
       WHERE i.invitee_user_id = $1 AND i.status = 'pending'
       ORDER BY i.invited_at DESC`,
      [userId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching invitations:', error);
    res.status(500).json({ error: 'Failed to fetch invitations' });
  }
});

/**
 * Respond to invitation
 * POST /api/invitations/:id/respond
 */
router.post('/:id/respond', authenticate, async (req, res) => {
  const { id } = req.params;
  const { accept } = req.body;
  const userId = req.user.id;
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get invitation
    const inviteResult = await client.query(
      `SELECT i.*, l.max_teams
       FROM league_invitations i
       JOIN leagues l ON i.league_id = l.id
       WHERE i.id = $1 AND i.invitee_user_id = $2 AND i.status = 'pending'`,
      [id, userId]
    );
    
    if (!inviteResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invitation not found' });
    }
    
    const invitation = inviteResult.rows[0];
    
    if (accept) {
      // Check if league is full
      const teamCountResult = await client.query(
        'SELECT COUNT(*) FROM teams WHERE league_id = $1 AND user_id IS NOT NULL',
        [invitation.league_id]
      );
      
      const currentTeams = parseInt(teamCountResult.rows[0].count);
      
      if (currentTeams >= invitation.max_teams) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'League is full' });
      }
      
      // Check if user already has a team in this league
      const userTeamResult = await client.query(
        'SELECT id FROM teams WHERE league_id = $1 AND user_id = $2',
        [invitation.league_id, userId]
      );
      
      if (userTeamResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You already have a team in this league' });
      }
      
      // Find an available team (one without a user_id)
      const availableTeamResult = await client.query(
        'SELECT id FROM teams WHERE league_id = $1 AND user_id IS NULL LIMIT 1',
        [invitation.league_id]
      );
      
      if (!availableTeamResult.rows.length) {
        // Create a new team
        const teamResult = await client.query(
          `INSERT INTO teams (name, league_id, user_id, salary_cap, luxury_tax_threshold)
           VALUES ($1, $2, $3, 120000000, 150000000)
           RETURNING id`,
          [`Team ${currentTeams + 1}`, invitation.league_id, userId]
        );
        
        const teamId = teamResult.rows[0].id;
        
        // Create roster entry
        await client.query(
          'INSERT INTO rosters (team_id, league_id) VALUES ($1, $2)',
          [teamId, invitation.league_id]
        );
      } else {
        // Assign existing team to user
        await client.query(
          'UPDATE teams SET user_id = $1 WHERE id = $2',
          [userId, availableTeamResult.rows[0].id]
        );
      }
      
      // Update invitation status
      await client.query(
        `UPDATE league_invitations 
         SET status = 'accepted', responded_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );
      
      // Create activity
      await client.query(
        `INSERT INTO league_activity (league_id, activity_type, title, description)
         VALUES ($1, 'user_joined', 'New GM Joined', $2)`,
        [invitation.league_id, `${req.user.username} joined the league`]
      );
    } else {
      // Decline invitation
      await client.query(
        `UPDATE league_invitations 
         SET status = 'declined', responded_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );
    }
    
    await client.query('COMMIT');
    res.json({ success: true, accepted: accept });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error responding to invitation:', error);
    res.status(500).json({ error: 'Failed to respond to invitation' });
  } finally {
    client.release();
  }
});

/**
 * Get invitations for a league (commissioner only)
 * GET /api/invitations/league/:leagueId
 */
router.get('/league/:leagueId', authenticate, async (req, res) => {
  const { leagueId } = req.params;
  const userId = req.user.id;
  
  try {
    // Verify user is commissioner
    const leagueResult = await pool.query(
      'SELECT commissioner_user_id FROM leagues WHERE id = $1',
      [leagueId]
    );
    
    if (!leagueResult.rows.length) {
      return res.status(404).json({ error: 'League not found' });
    }
    
    if (leagueResult.rows[0].commissioner_user_id !== userId) {
      return res.status(403).json({ error: 'Only the commissioner can view invitations' });
    }
    
    const result = await pool.query(
      `SELECT 
        i.*,
        u.username as invitee_username
       FROM league_invitations i
       LEFT JOIN users u ON i.invitee_user_id = u.id
       WHERE i.league_id = $1
       ORDER BY i.invited_at DESC`,
      [leagueId]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching league invitations:', error);
    res.status(500).json({ error: 'Failed to fetch invitations' });
  }
});

/**
 * Cancel invitation (commissioner only)
 * DELETE /api/invitations/:id
 */
router.delete('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  
  try {
    // Verify user is commissioner
    const inviteResult = await pool.query(
      `SELECT i.league_id, l.commissioner_user_id
       FROM league_invitations i
       JOIN leagues l ON i.league_id = l.id
       WHERE i.id = $1`,
      [id]
    );
    
    if (!inviteResult.rows.length) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    
    if (inviteResult.rows[0].commissioner_user_id !== userId) {
      return res.status(403).json({ error: 'Only the commissioner can cancel invitations' });
    }
    
    await pool.query('DELETE FROM league_invitations WHERE id = $1', [id]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error canceling invitation:', error);
    res.status(500).json({ error: 'Failed to cancel invitation' });
  }
});

module.exports = router;
