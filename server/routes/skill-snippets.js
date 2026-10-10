import express from 'express';

export function createSkillSnippetsRouter({ service, requireSystemAdmin, authenticateToken }) {
  const router = express.Router();
  if (authenticateToken) router.use(['/skill-snippets', '/admin/skill-snippets'], authenticateToken);
  router.use(['/skill-snippets', '/admin/skill-snippets'], (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  const route = (handler) => (req, res) => {
    try { handler(req, res); } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '片段操作失败，请重试。', code: error.code || 'SNIPPET_ERROR' });
    }
  };
  const send = (res, snippet, status = 200) => res.status(status).set('ETag', `"${snippet.contentHash}"`).json({ snippet });
  router.get('/skill-snippets', route((req, res) => res.json({
    snippets: service.list(req.query.q),
    canManage: req.user.is_system_admin === 1 || req.user.is_system_admin === true,
  })));
  router.get('/skill-snippets/:id', route((req, res) => send(res, service.get(req.params.id))));
  router.post('/admin/skill-snippets', requireSystemAdmin, route((req, res) => send(res, service.create(req.body, req.user.id), 201)));
  router.patch('/admin/skill-snippets/:id', requireSystemAdmin, route((req, res) => send(res, service.update(req.params.id, req.body, req.user.id, req.get('If-Match')))));
  router.delete('/admin/skill-snippets/:id', requireSystemAdmin, route((req, res) => {
    service.remove(req.params.id, req.user.id, req.get('If-Match'));
    res.status(204).end();
  }));
  return router;
}
