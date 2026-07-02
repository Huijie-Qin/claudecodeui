export function noApiCache(req, res, next) {
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
}

export default noApiCache;
