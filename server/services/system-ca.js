import tls from 'node:tls';

export function mergeSystemCaCertificates(tlsApi = tls) {
  if (
    typeof tlsApi?.getCACertificates !== 'function'
    || typeof tlsApi?.setDefaultCACertificates !== 'function'
  ) {
    return {
      enabled: false,
      reason: 'unsupported_node_runtime',
      systemCertificateCount: 0,
    };
  }

  try {
    const defaultCertificates = tlsApi.getCACertificates('default');
    const systemCertificates = tlsApi.getCACertificates('system');

    if (!Array.isArray(systemCertificates) || systemCertificates.length === 0) {
      return {
        enabled: false,
        reason: 'empty_system_store',
        systemCertificateCount: 0,
      };
    }

    const mergedCertificates = [...new Set([
      ...(Array.isArray(defaultCertificates) ? defaultCertificates : []),
      ...systemCertificates,
    ])];
    tlsApi.setDefaultCACertificates(mergedCertificates);

    return {
      enabled: true,
      reason: null,
      systemCertificateCount: systemCertificates.length,
      trustedCertificateCount: mergedCertificates.length,
    };
  } catch (error) {
    return {
      enabled: false,
      reason: 'system_store_unavailable',
      systemCertificateCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

