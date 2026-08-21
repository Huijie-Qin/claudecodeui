import { promises as fs } from 'node:fs';
import path from 'node:path';

import express from 'express';

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const METADATA_CACHE_CONTROL = 'no-store';
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+() -]{0,239}$/;
const VERSION_PATTERN = /(?:^|[ _-])v?\d+\.\d+\.\d+(?=$|[._ +()-])/;
const ACCEL_REDIRECT_PREFIX_PATTERN = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/;
const MAX_ACCEL_REDIRECT_PREFIX_LENGTH = 200;

const SUPPORTED_TARGETS = new Map([
  ['mac/universal', {
    metadataFilename: 'latest-mac.yml',
    artifactPattern: /\.(?:dmg|zip)(?:\.blockmap)?$/,
  }],
  ['win/x64', {
    metadataFilename: 'latest.yml',
    artifactPattern: /\.exe(?:\.blockmap)?$/,
  }],
]);

function isMissingPathError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'ELOOP';
}

function isPathInside(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath !== '' && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath);
}

function classifyRequest({ channel, platform, arch, filename }) {
  if (channel !== 'latest' || !SAFE_FILENAME_PATTERN.test(filename)) {
    return null;
  }

  const target = SUPPORTED_TARGETS.get(`${platform}/${arch}`);
  if (!target) {
    return null;
  }

  if (filename === target.metadataFilename) {
    return { isMetadata: true };
  }

  if (!VERSION_PATTERN.test(filename) || !target.artifactPattern.test(filename)) {
    return null;
  }

  return { isMetadata: false };
}

function parseAccelRedirectPrefix(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return { status: 'disabled' };
  }

  if (typeof value !== 'string') {
    return { status: 'invalid' };
  }

  const prefix = value.trim();
  if (prefix.length > MAX_ACCEL_REDIRECT_PREFIX_LENGTH || !ACCEL_REDIRECT_PREFIX_PATTERN.test(prefix)) {
    return { status: 'invalid' };
  }

  return {
    status: 'enabled',
    prefix: prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
  };
}

function createAccelRedirectUri(prefix, relativeFilePath) {
  const encodedPath = relativeFilePath
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${prefix}/${encodedPath}`;
}

async function resolveUpdateFile(updateRoot, routeParts) {
  let realRoot;
  try {
    realRoot = await fs.realpath(updateRoot);
  } catch (error) {
    if (isMissingPathError(error) || error?.code === 'EACCES') {
      return { status: 'unavailable' };
    }
    throw error;
  }

  try {
    const rootStats = await fs.stat(realRoot);
    if (!rootStats.isDirectory()) {
      return { status: 'unavailable' };
    }
  } catch (error) {
    if (isMissingPathError(error) || error?.code === 'EACCES') {
      return { status: 'unavailable' };
    }
    throw error;
  }

  const requestedPath = path.resolve(
    realRoot,
    routeParts.channel,
    routeParts.platform,
    routeParts.arch,
    routeParts.filename,
  );
  if (!isPathInside(realRoot, requestedPath)) {
    return { status: 'not-found' };
  }

  let realFilePath;
  try {
    realFilePath = await fs.realpath(requestedPath);
  } catch (error) {
    if (isMissingPathError(error) || error?.code === 'EACCES') {
      return { status: 'not-found' };
    }
    throw error;
  }

  // realpath resolves every symlink in the path. Comparing that result with the
  // canonical root prevents both a symlinked directory and a symlinked artifact
  // from escaping DESKTOP_UPDATE_ROOT.
  if (!isPathInside(realRoot, realFilePath)) {
    return { status: 'not-found' };
  }

  try {
    const fileStats = await fs.stat(realFilePath);
    if (!fileStats.isFile()) {
      return { status: 'not-found' };
    }
  } catch (error) {
    if (isMissingPathError(error) || error?.code === 'EACCES') {
      return { status: 'not-found' };
    }
    throw error;
  }

  return {
    status: 'found',
    filePath: realFilePath,
    relativeFilePath: path.relative(realRoot, realFilePath),
  };
}

export function createDesktopUpdatesRouter({
  updateRoot = process.env.DESKTOP_UPDATE_ROOT,
  accelRedirectPrefix = process.env.DESKTOP_UPDATE_ACCEL_REDIRECT_PREFIX,
} = {}) {
  const router = express.Router({ caseSensitive: true, strict: true });
  const configuredRoot = typeof updateRoot === 'string' ? updateRoot.trim() : '';
  const accelRedirect = parseAccelRedirectPrefix(accelRedirectPrefix);

  async function serveDesktopUpdate(req, res, next) {
    const routeParts = {
      channel: req.params.channel,
      platform: req.params.platform,
      arch: req.params.arch,
      filename: req.params.filename,
    };
    const requestType = classifyRequest(routeParts);

    if (!requestType) {
      res.status(404).json({ error: 'Desktop update not found' });
      return;
    }

    if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
      res.status(503).json({ error: 'Desktop update service is not configured' });
      return;
    }
    if (accelRedirect.status === 'invalid') {
      res.status(503).json({ error: 'Desktop update service is not configured' });
      return;
    }

    let resolvedFile;
    try {
      resolvedFile = await resolveUpdateFile(configuredRoot, routeParts);
    } catch (error) {
      next(error);
      return;
    }

    if (resolvedFile.status === 'unavailable') {
      res.status(503).json({ error: 'Desktop update service is unavailable' });
      return;
    }
    if (resolvedFile.status !== 'found') {
      res.status(404).json({ error: 'Desktop update not found' });
      return;
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (requestType.isMetadata) {
      res.setHeader('Cache-Control', METADATA_CACHE_CONTROL);
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
    }

    // Nginx evaluates X-Accel-Redirect as an internal URI. Emit it only after
    // the requested artifact has passed the same filename, realpath, regular
    // file, and root-boundary checks used by the sendFile fallback. The URI is
    // built from the canonical in-root path rather than untrusted URL input.
    if (!requestType.isMetadata && accelRedirect.status === 'enabled') {
      res.setHeader(
        'X-Accel-Redirect',
        createAccelRedirectUri(accelRedirect.prefix, resolvedFile.relativeFilePath),
      );
      res.status(200).end();
      return;
    }

    res.sendFile(resolvedFile.filePath, {
      acceptRanges: true,
      cacheControl: false,
      dotfiles: 'deny',
      lastModified: true,
    });
  }

  router
    .route('/:channel/:platform/:arch/:filename')
    .head(serveDesktopUpdate)
    .get(serveDesktopUpdate);

  return router;
}

export default createDesktopUpdatesRouter();
