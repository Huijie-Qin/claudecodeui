import { USER_KEY_ENV_NAME } from '../database/user-env.js';

export function createPersonalKeyHandler({ getEnvForUser, logger = console }) {
  if (typeof getEnvForUser !== 'function') {
    throw new TypeError('getEnvForUser must be a function');
  }

  return (req, res) => {
    try {
      const personalKey = getEnvForUser(req.user.id)?.[USER_KEY_ENV_NAME];

      if (!personalKey) {
        return res.status(404).json({ success: false, error: 'Personal key not found' });
      }

      res.set('Cache-Control', 'no-store');
      res.set('Pragma', 'no-cache');
      return res.json({ success: true, personalKey });
    } catch (error) {
      logger.error('Error fetching personal key:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch personal key' });
    }
  };
}
