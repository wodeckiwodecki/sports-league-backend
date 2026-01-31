const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const leagueRoutes = require('./routes/leagues');
const leaguesEnhancedRoutes = require('./routes/leagues-enhanced');
const invitationsRoutes = require('./routes/invitations');
const teamRoutes = require('./routes/teams');
const playerRoutes = require('./routes/players');
const tradeRoutes = require('./routes/trades');
const contractRoutes = require('./routes/contracts');
const gameRoutes = require('./routes/games');
const draftRoutes = require('./routes/draft');
const nbaRoutes = require('./routes/nba');

const { initializeDatabase } = require('./database/init');
const { processLeagueDay } = require('./services/timeProgressionService');
const { setupWebSocketHandlers } = require('./services/websocketService');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Make io accessible to routes
app.set('io', io);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/leagues', leagueRoutes);
app.use('/api/leagues-v2', leaguesEnhancedRoutes); // New multiplayer leagues
app.use('/api/invitations', invitationsRoutes); // League invitations
app.use('/api/teams', teamRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/draft', draftRoutes);
app.use('/api/nba', nbaRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// WebSocket connection handling
setupWebSocketHandlers(io);

// Time progression scheduler - runs every minute
cron.schedule('* * * * *', async () => {
  try {
    await processLeagueDay(io);
  } catch (error) {
    console.error('Error in time progression:', error);
  }
});

// Initialize database and start server
const PORT = process.env.PORT || 5000;

initializeDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server ready`);
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});

module.exports = { app, io };
