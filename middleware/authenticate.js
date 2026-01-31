const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Set user from decoded token
    req.user = {
      id: decoded.userId,
      email: decoded.email
    };
    
    next();
  } catch (error) {
    console.error('Authentication error:', error.message);
    return res.status(401).json({ error: 'Invalid or expired token', details: error.message });
  }
};

module.exports = authenticate;
