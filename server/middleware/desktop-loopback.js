const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

function parsePort(rawPort) {
  if (rawPort == null || rawPort === '') return null;
  if (!/^\d{1,5}$/.test(rawPort)) return null;
  const port = Number(rawPort);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function parseLoopbackAuthority(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    return null;
  }

  let hostname;
  let rawPort = null;
  if (value.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(value);
    if (!match) return null;
    hostname = match[1].toLowerCase();
    rawPort = match[2] ?? null;
  } else {
    const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(value);
    if (!match) return null;
    hostname = match[1].toLowerCase();
    rawPort = match[2] ?? null;
  }

  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    return null;
  }

  const port = parsePort(rawPort);
  if (rawPort != null && port == null) {
    return null;
  }
  return { hostname, port };
}

export function parseLoopbackOrigin(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    return null;
  }

  const match = /^http:\/\/([^/?#]+)\/?$/i.exec(value);
  if (!match) return null;
  const authority = parseLoopbackAuthority(match[1]);
  if (!authority) return null;
  return {
    ...authority,
    origin: `http://${authority.hostname === '::1' ? '[::1]' : authority.hostname}${authority.port ? `:${authority.port}` : ''}`,
  };
}

function effectivePort(authority) {
  return authority.port ?? 80;
}

export function validateDesktopLoopbackRequest(request, { requireOrigin = false } = {}) {
  const host = parseLoopbackAuthority(request?.headers?.host);
  if (!host) {
    return { ok: false, reason: 'host_not_loopback' };
  }

  const localPort = Number(request?.socket?.localPort);
  if (Number.isInteger(localPort) && localPort > 0 && effectivePort(host) !== localPort) {
    return { ok: false, reason: 'host_port_mismatch' };
  }

  const rawOrigin = request?.headers?.origin;
  if (rawOrigin == null || rawOrigin === '') {
    return requireOrigin
      ? { ok: false, reason: 'origin_required' }
      : { ok: true, host, origin: null };
  }

  const origin = parseLoopbackOrigin(rawOrigin);
  if (!origin) {
    return { ok: false, reason: 'origin_not_loopback' };
  }

  const expectedPort = Number.isInteger(localPort) && localPort > 0
    ? localPort
    : effectivePort(host);
  if (effectivePort(origin) !== expectedPort) {
    return { ok: false, reason: 'origin_port_mismatch' };
  }

  return { ok: true, host, origin };
}

export function createDesktopLoopbackMiddleware({ enabled }) {
  if (!enabled) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const validation = validateDesktopLoopbackRequest(req);
    if (!validation.ok) {
      res.status(403).json({
        error: 'Desktop requests must use the local application origin',
        code: 'DESKTOP_LOOPBACK_REQUIRED',
      });
      return;
    }
    next();
  };
}

export function validateDesktopWebSocketRequest(request) {
  return validateDesktopLoopbackRequest(request, { requireOrigin: true });
}
