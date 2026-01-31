/**
 * WebSocket service for real-time league updates
 */
function setupWebSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Join league room
    socket.on('join_league', (leagueId) => {
      socket.join(`league_${leagueId}`);
      console.log(`Socket ${socket.id} joined league ${leagueId}`);
      
      socket.emit('joined_league', {
        leagueId,
        message: 'Successfully joined league updates'
      });
    });

    // Leave league room
    socket.on('leave_league', (leagueId) => {
      socket.leave(`league_${leagueId}`);
      console.log(`Socket ${socket.id} left league ${leagueId}`);
    });

    // Join team room for team-specific updates
    socket.on('join_team', (teamId) => {
      socket.join(`team_${teamId}`);
      console.log(`Socket ${socket.id} joined team ${teamId}`);
    });

    // Real-time trade notifications
    socket.on('trade_proposed', (data) => {
      // Notify the receiving team
      io.to(`team_${data.receivingTeamId}`).emit('incoming_trade', {
        tradeId: data.tradeId,
        fromTeam: data.fromTeam,
        message: data.message
      });
    });

    socket.on('trade_accepted', (data) => {
      // Notify both teams and the league
      io.to(`team_${data.proposingTeamId}`).emit('trade_completed', data);
      io.to(`team_${data.receivingTeamId}`).emit('trade_completed', data);
      io.to(`league_${data.leagueId}`).emit('trade_completed', data);
    });

    socket.on('trade_declined', (data) => {
      // Notify the proposing team
      io.to(`team_${data.proposingTeamId}`).emit('trade_declined', {
        tradeId: data.tradeId,
        message: data.message
      });
    });

    // Contract offer notifications
    socket.on('contract_offered', (data) => {
      io.to(`league_${data.leagueId}`).emit('contract_activity', {
        teamId: data.teamId,
        playerId: data.playerId,
        type: 'offer'
      });
    });

    socket.on('contract_signed', (data) => {
      io.to(`league_${data.leagueId}`).emit('contract_signed', {
        teamId: data.teamId,
        playerName: data.playerName,
        years: data.years,
        salary: data.salary
      });
    });

    // Draft events
    socket.on('draft_pick_made', (data) => {
      io.to(`league_${data.leagueId}`).emit('draft_pick', {
        teamId: data.teamId,
        teamName: data.teamName,
        playerId: data.playerId,
        playerName: data.playerName,
        pickNumber: data.pickNumber
      });
    });

    // Live game updates (if implementing real-time game viewing)
    socket.on('watch_game', (gameId) => {
      socket.join(`game_${gameId}`);
    });

    socket.on('stop_watching_game', (gameId) => {
      socket.leave(`game_${gameId}`);
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });
}

/**
 * Emit a league-wide notification
 */
function emitToLeague(io, leagueId, event, data) {
  io.to(`league_${leagueId}`).emit(event, data);
}

/**
 * Emit a team-specific notification
 */
function emitToTeam(io, teamId, event, data) {
  io.to(`team_${teamId}`).emit(event, data);
}

/**
 * Emit a game-specific update
 */
function emitToGame(io, gameId, event, data) {
  io.to(`game_${gameId}`).emit(event, data);
}

module.exports = {
  setupWebSocketHandlers,
  emitToLeague,
  emitToTeam,
  emitToGame
};
