const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// JWT secret — auto-generated if not provided (will change on restart!)
// For persistent sessions across restarts, set JWT_SECRET env var
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

// Session duration in seconds (default 24 hours)
const SESSION_DURATION = process.env.SESSION_HOURS
  ? parseInt(process.env.SESSION_HOURS) * 3600
  : 24 * 3600;

class Auth {
  constructor() {
    this._passwordHash = null;
    this._init();
  }

  _init() {
    const password = process.env.DASHBOARD_PASSWORD;
    if (password) {
      // Hash the password from env var with bcrypt (cost factor 12)
      this._passwordHash = bcrypt.hashSync(password, 12);
    }
  }

  /**
   * Verify a login password against the stored hash
   */
  async verifyPassword(inputPassword) {
    if (!inputPassword) return false;

    // If no password configured, reject ALL logins
    if (!this._passwordHash) {
      console.error('⚠️  DASHBOARD_PASSWORD environment variable is not set — login is disabled!');
      return false;
    }

    return bcrypt.compareSync(inputPassword, this._passwordHash);
  }

  /**
   * Generate a signed JWT token
   */
  generateToken() {
    return jwt.sign(
      {
        role: 'admin',
        iat: Math.floor(Date.now() / 1000)
      },
      JWT_SECRET,
      { expiresIn: SESSION_DURATION }
    );
  }

  /**
   * Verify a JWT token is valid and not expired
   */
  verifyToken(token) {
    try {
      jwt.verify(token, JWT_SECRET);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cookie options for secure token storage
   */
  cookieOptions() {
    return {
      httpOnly: true,                                        // Not accessible via JavaScript
      secure: process.env.NODE_ENV === 'production',         // HTTPS only in production
      sameSite: 'strict',                                    // CSRF protection
      maxAge: SESSION_DURATION * 1000,                       // Expiry matches JWT
      path: '/'
    };
  }
}

module.exports = new Auth();
