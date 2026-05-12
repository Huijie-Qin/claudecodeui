import crypto from 'crypto';

import bcrypt from 'bcrypt';
import express from 'express';

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

function hashInvitationToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getInvitationFailure(invitation) {
  if (!invitation) {
    return { statusCode: 404, message: 'Invitation not found' };
  }

  if (invitation.accepted_at || invitation.is_active === 1) {
    return { statusCode: 410, message: 'Invitation has already been accepted' };
  }

  if (invitation.revoked_at) {
    return { statusCode: 410, message: 'Invitation has been revoked' };
  }

  const expiresAt = Date.parse(invitation.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { statusCode: 410, message: 'Invitation has expired' };
  }

  return null;
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
      const { username, password, gitEmail } = req.body;

      // Validate input
      if (!username || !password || !gitEmail) {
        return res.status(400).json({ error: 'Username, password, and git email are required' });
      }

      const gitEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!gitEmailPattern.test(gitEmail)) {
        return res.status(400).json({ error: 'Invalid git email format' });
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
        const trimmedGitEmail = gitEmail.trim();
        if (typeof userDb.updateGitConfig === 'function') {
          userDb.updateGitConfig(user.id, username, trimmedGitEmail);
        }
        if (typeof userDb.completeOnboarding === 'function') {
          userDb.completeOnboarding(user.id);
        }
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

  router.get('/invitations/:token', (req, res) => {
    try {
      if (typeof userDb.getInvitationByTokenHash !== 'function') {
        return res.status(404).json({ error: 'Invitation not found' });
      }

      const invitation = userDb.getInvitationByTokenHash(hashInvitationToken(req.params.token));
      const failure = getInvitationFailure(invitation);
      if (failure) {
        return res.status(failure.statusCode).json({ error: failure.message });
      }

      return res.json({
        invitation: {
          username: invitation.username,
          expires_at: invitation.expires_at,
        },
      });
    } catch (error) {
      console.error('Invitation lookup error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/invitations/:token/accept', async (req, res) => {
    try {
      const { password, gitEmail } = req.body;
      if (!password || !gitEmail) {
        return res.status(400).json({ error: 'Password and git email are required' });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }

      const gitEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!gitEmailPattern.test(gitEmail)) {
        return res.status(400).json({ error: 'Invalid git email format' });
      }

      if (
        typeof userDb.getInvitationByTokenHash !== 'function'
        || typeof userDb.acceptInvitation !== 'function'
      ) {
        return res.status(404).json({ error: 'Invitation not found' });
      }

      const tokenHash = hashInvitationToken(req.params.token);
      const invitation = userDb.getInvitationByTokenHash(tokenHash);
      const failure = getInvitationFailure(invitation);
      if (failure) {
        return res.status(failure.statusCode).json({ error: failure.message });
      }

      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      const user = userDb.acceptInvitation({ tokenHash, passwordHash });
      if (!user) {
        return res.status(410).json({ error: 'Invitation is no longer available' });
      }

      const trimmedGitEmail = gitEmail.trim();
      if (typeof userDb.updateGitConfig === 'function') {
        userDb.updateGitConfig(user.id, user.username, trimmedGitEmail);
      }
      if (typeof userDb.completeOnboarding === 'function') {
        userDb.completeOnboarding(user.id);
      }

      const token = generateToken(user);
      userDb.updateLastLogin(user.id);

      return res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          is_system_admin: user.is_system_admin,
        },
        token,
      });
    } catch (error) {
      console.error('Invitation acceptance error:', error);
      return res.status(500).json({ error: 'Internal server error' });
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
