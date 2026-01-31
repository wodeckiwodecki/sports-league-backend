# Sports League Management Backend

AI-powered backend for managing custom sports leagues with automated game simulation, player development, trades, and contract negotiations.

## Features

- **AI-Powered Game Simulation**: Uses Claude API to generate realistic game narratives and statistics
- **Time Progression System**: Configurable real-time to in-game time ratio
- **Trade Management**: AI evaluation of trade proposals
- **Contract Negotiations**: Dynamic agent responses to contract offers
- **Player Development**: AI-driven player rating changes based on performance
- **Real-Time Updates**: WebSocket support for live league events
- **Storyline Generation**: Daily AI-generated league news and events

## Prerequisites

- Node.js (v16 or higher)
- PostgreSQL (v13 or higher)
- Anthropic API key

## Installation

1. **Clone the repository and install dependencies:**

```bash
npm install
```

2. **Set up PostgreSQL database:**

```bash
createdb sports_league
```

3. **Configure environment variables:**

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:
```
PORT=5000
DB_USER=postgres
DB_HOST=localhost
DB_NAME=sports_league
DB_PASSWORD=your_password
DB_PORT=5432
ANTHROPIC_API_KEY=your_api_key_here
JWT_SECRET=your_jwt_secret
CLIENT_URL=http://localhost:3000
```

4. **Initialize the database:**

```bash
npm run init-db
```

5. **Start the server:**

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

The server will run on `http://localhost:5000`

## API Documentation

### Authentication

#### Register User
```http
POST /api/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123",
  "username": "player1"
}
```

#### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```

#### Get Current User
```http
GET /api/auth/me
Authorization: Bearer <token>
```

### Leagues

#### Create League
```http
POST /api/leagues
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "My Basketball League",
  "ownerId": 1,
  "sport": "NBA",
  "salaryCap": 150000000,
  "timeRatio": {
    "real_hours": 24,
    "league_days": 7
  },
  "draftType": "snake"
}
```

#### Get League Details
```http
GET /api/leagues/:leagueId
```

#### Manually Advance League
```http
POST /api/leagues/:leagueId/advance
Content-Type: application/json

{
  "days": 1
}
```

#### Get League Storylines
```http
GET /api/leagues/:leagueId/storylines?limit=10
```

### Teams

#### Get Team with Roster
```http
GET /api/teams/:teamId
```

#### Get League Standings
```http
GET /api/teams/league/:leagueId
```

#### Create Team
```http
POST /api/teams
Content-Type: application/json

{
  "leagueId": 1,
  "userId": 1,
  "name": "Brooklyn Dynamics",
  "abbreviation": "BKD"
}
```

#### Get Team Schedule
```http
GET /api/teams/:teamId/schedule?season=1
```

#### Get Team Stats
```http
GET /api/teams/:teamId/stats?season=1
```

### Players

#### Search Players
```http
GET /api/players?position=PG&minOverall=85&search=Johnson
```

#### Get Player Details
```http
GET /api/players/:playerId?leagueId=1
```

#### Create Player
```http
POST /api/players
Content-Type: application/json

{
  "name": "Marcus Johnson",
  "position": "PG",
  "age": 22,
  "overallRating": 85,
  "potential": 92,
  "draftYear": 2024,
  "draftClass": "2024"
}
```

#### Create Multiple Players (Draft Class)
```http
POST /api/players/bulk
Content-Type: application/json

{
  "players": [
    {
      "name": "Player 1",
      "position": "PG",
      "overallRating": 85,
      "draftYear": 2024,
      "draftClass": "2024"
    },
    {
      "name": "Player 2",
      "position": "SG",
      "overallRating": 82,
      "draftYear": 2024,
      "draftClass": "2024"
    }
  ]
}
```

### Trades

#### Get Incoming Trade Proposals
```http
GET /api/trades/team/:teamId/incoming
```

#### Create Trade Proposal
```http
POST /api/trades
Content-Type: application/json

{
  "leagueId": 1,
  "proposingTeamId": 1,
  "receivingTeamId": 2,
  "offeringPlayerIds": [1, 2],
  "requestingPlayerIds": [3],
  "message": "Let's make a deal!"
}
```

#### Accept Trade
```http
PUT /api/trades/:tradeId/accept
```

#### Decline Trade
```http
PUT /api/trades/:tradeId/decline
Content-Type: application/json

{
  "message": "Thanks, but no thanks"
}
```

### Contracts

#### Get Free Agents
```http
GET /api/contracts/free-agents/:leagueId?position=PG
```

#### Make Contract Offer
```http
POST /api/contracts/offer
Content-Type: application/json

{
  "teamId": 1,
  "playerId": 5,
  "leagueId": 1,
  "years": 3,
  "annualSalary": 25000000
}
```

#### Get Team's Contract Offers
```http
GET /api/contracts/team/:teamId
```

#### Get Expiring Contracts
```http
GET /api/contracts/expiring/:leagueId?teamId=1
```

### Games

#### Get League Games
```http
GET /api/games/league/:leagueId?season=1&status=completed
```

#### Get Game Details
```http
GET /api/games/:gameId
```

#### Get Today's Games
```http
GET /api/games/today/:leagueId
```

#### Create Game Schedule
```http
POST /api/games/schedule
Content-Type: application/json

{
  "leagueId": 1,
  "season": 1,
  "gamesPerTeam": 82
}
```

#### Get Standings
```http
GET /api/games/standings/:leagueId
```

## WebSocket Events

Connect to the WebSocket server at `http://localhost:5000`

### Client → Server Events

```javascript
// Join a league room to receive updates
socket.emit('join_league', leagueId);

// Join a team room
socket.emit('join_team', teamId);

// Watch a specific game
socket.emit('watch_game', gameId);
```

### Server → Client Events

```javascript
// League day advanced
socket.on('league_day_advanced', (data) => {
  // { leagueId, currentDay, currentSeason }
});

// Game completed
socket.on('game_completed', (data) => {
  // { gameId, homeTeam, awayTeam, homeScore, awayScore, highlights }
});

// New storylines
socket.on('new_storylines', (data) => {
  // { leagueId, day, storylines }
});

// Trade notifications
socket.on('incoming_trade', (data) => {
  // { tradeId, fromTeam, message }
});

socket.on('trade_completed', (data) => {
  // { tradeId, proposingTeamId, receivingTeamId, leagueId }
});

// Contract signed
socket.on('contract_signed', (data) => {
  // { teamId, teamName, playerId, playerName, years, salary }
});

// Player development
socket.on('player_development', (data) => {
  // { playerId, change, reason }
});
```

## Time Progression System

The backend uses a cron job that runs every minute to check if any leagues need to advance based on their configured time ratio.

**Example Time Ratios:**
- `{ real_hours: 24, league_days: 7 }` - 7 league days pass every 24 real hours
- `{ real_hours: 1, league_days: 1 }` - 1 league day passes every real hour
- `{ real_hours: 12, league_days: 1 }` - 1 league day passes every 12 real hours

When a league day advances:
1. Scheduled games are simulated using AI
2. Player stats are updated
3. Storylines are generated
4. Player development occurs (every 7 days)
5. WebSocket events notify connected clients

## AI Integration

The backend uses Claude (Anthropic API) for:

1. **Game Simulation**: Generates realistic play-by-play narratives and statistics
2. **Trade Evaluation**: Analyzes fairness and provides GM perspective
3. **Contract Negotiation**: Simulates agent responses to offers
4. **Storyline Generation**: Creates daily news and events
5. **Player Development**: Determines rating changes based on performance

## Database Schema

- **users**: User accounts
- **leagues**: League configurations
- **teams**: Teams in leagues
- **players**: Player database
- **team_rosters**: Junction table for team-player relationships
- **player_stats**: Season statistics
- **trades**: Trade proposals and history
- **contract_offers**: Free agent negotiations
- **games**: Game schedules and results
- **storylines**: AI-generated league events

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Initialize/reset database
npm run init-db
```

## Deployment

For production deployment:

1. Set `NODE_ENV=production` in `.env`
2. Use a PostgreSQL production database
3. Set secure JWT_SECRET
4. Configure CORS for your frontend domain
5. Use a process manager like PM2:

```bash
npm install -g pm2
pm2 start server.js --name sports-league
```

## License

MIT
