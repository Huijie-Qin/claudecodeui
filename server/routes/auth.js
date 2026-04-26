import express from 'express';
import bcrypt from 'bcrypt';
import { userDb as defaultUserDb, db as defaultDb } from '../database/db.js';
import { multitenancyDb as defaultMultitenancyDb } from '../database/multitenancy-db.js';
import {
  generateToken as defaultGenerateToken,
  authenticateToken as defaultAuthenticateToken
} from '../middleware/auth.js';

function ensureBootstrapTenantForSystemAdmin(multitenancy, userId) {
  if (!multitenancy?.tenants || !multitenancy?.memberships) return null;

  const tenants = typeof multitenancy.tenants.listTenants === 'function'
    ? multitenancy.tenants.listTenants()
    : [];
  const tenant = tenants.find((row) => row.code === 'default') ?? multitenancy.tenants.createTenant({
    code: 'default',
    name: 'Default',
    status: 'active',
  });

  multitenancy.memberships.upsertMembership({
    tenantId: tenant.id,
    userId,
    role: 'system_admin',
    permission: 'edit',
    status: 'active',
  });

  return tenant;
}

export function createAuthRouter({
  userDb = defaultUserDb,
  db = defaultDb,
  multitenancy = defaultMultitenancyDb,
  generateToken = defaultGenerateToken,
  authenticateToken = defaultAuthenticateToken,
} = {}) {
  const router = express.Router();

  // Check auth status and setup requirements
  router.get('/status', async (req, res) => {
    try {
      const hasUsers = await userDb.hasUsers();
      res.json({
        needsSetup: !hasUsers,
        isAuthenticated: false, // Will be overridden by frontend if token exists
        allowRegistration: hasUsers,
      });
    } catch (error) {
      console.error('Auth status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Public registration. The first user bootstraps system administration.
  router.post('/register', async (req, res) => {
    try {
      const { username, password } = req.body;

      // Validate input
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      if (username.length < 3 || password.length < 6) {
        return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
      }

      // Use a transaction to prevent race conditions
      db.prepare('BEGIN').run();
      try {
        const isFirstUser = !userDb.hasUsers();

        // Hash password
        const saltRounds = 12;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Create user
        const user = userDb.createUser(username, passwordHash, { isSystemAdmin: isFirstUser });
        if (isFirstUser) {
          ensureBootstrapTenantForSystemAdmin(multitenancy, user.id);
        }

        // Generate token
        const token = generateToken(user);

        db.prepare('COMMIT').run();

        // Update last login (non-fatal, outside transaction)
        userDb.updateLastLogin(user.id);

        res.json({
          success: true,
          user: {
            id: user.id,
            username: user.username,
            is_system_admin: user.is_system_admin,
          },
          token,
          bootstrapAdmin: isFirstUser,
        });
      } catch (error) {
        db.prepare('ROLLBACK').run();
        throw error;
      }
    } catch (error) {
      console.error('Registration error:', error);
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({ error: 'Username already exists' });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // User login
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      // Validate input
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      // Get user from database
      const user = userDb.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // Generate token
      const token = generateToken(user);

      // Update last login
      userDb.updateLastLogin(user.id);

      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          is_system_admin: user.is_system_admin,
        },
        token,
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get current user (protected route)
  router.get('/user', authenticateToken, (req, res) => {
    res.json({
      user: req.user
    });
  });

  // Logout (client-side token removal, but this endpoint can be used for logging)
  router.post('/logout', authenticateToken, (req, res) => {
    // In a simple JWT system, logout is mainly client-side
    // This endpoint exists for consistency and potential future logging
    res.json({ success: true, message: 'Logged out successfully' });
  });

  return router;
}

export default createAuthRouter();
