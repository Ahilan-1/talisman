const BASE = 'https://arlong.org/api/arlong';

export function publicWebUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use a public HTTP or HTTPS URL');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test') ||
      /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|::1$)/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) throw Error('Private network addresses are unavailable');
  return url.href;
}

export function searchEvidence(payload, query) {
  if (!Array.isArray(payload?.results)) throw Error('Arlong search returned an invalid response');
  const results = payload.results.slice(0, 10).flatMap(hit => {
    try {
      const url = publicWebUrl(hit.url);
      const screening = hit.screening || {};
      const admitted = screening.decision === 'allow' && hit.metadata_screened === true;
      if (!admitted) return [];
      return [{ title: String(hit.title || '').slice(0, 180), url, snippet: String(hit.content || '').slice(0, 900), contentSource: 'index_excerpt', evidenceEligible: false }];
    } catch { return []; }
  });
  return { query, engine: 'arlong', results, partial: !!payload.retrieval?.partial, note: 'Index excerpts help find sources; open or extract a page before treating its details as verified.' };
}

export function extractedEvidence(payload, url) {
  if (payload?.evidence_eligible !== true || payload.security_analysis?.action !== 'allow' || typeof payload.content !== 'string' || !payload.content.trim()) {
    throw Error('Arlong could not verify readable content for this page');
  }
  return { url, title: String(payload.title || '').slice(0, 180), text: payload.content.slice(0, 12000), source: 'arlong_extract', evidenceEligible: true };
}

export function screenedEvidence(payload) {
  const allowed = payload?.decision === 'allow' && payload.trust_contract?.allowed_for_context === true && typeof payload.safe_content === 'string' && !!payload.safe_content.trim();
  return { decision: allowed ? 'allow' : (payload?.decision === 'block' ? 'block' : 'quarantine'), safeContent: allowed ? payload.safe_content.slice(0, 12000) : '', signals: Array.isArray(payload?.signals) ? payload.signals.slice(0, 12) : [] };
}

export function createArlongClient(key = process.env.ARLONG_API_KEY || process.env.arlong) {
  const configured = !!key;
  async function call(route, body, timeoutMs) {
    if (!configured) throw Error('Arlong is not configured');
    const response = await fetch(`${BASE}/${route}`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw Error(`Arlong ${route} failed (${response.status})`);
    return response.json();
  }
  return {
    configured,
    async search(query) {
      const q = String(query || '').trim();
      if (!q || q.length > 300) throw Error('Search query must be 1–300 characters');
      return searchEvidence(await call('search', { q, max_results: 8 }, 20_000), q);
    },
    async extract(value) {
      const url = publicWebUrl(value);
      return extractedEvidence(await call('extract', { url, max_chars: 12000 }, 30_000), url);
    },
    async screen(value) {
      const url = String(value?.url || '').trim();
      const text = String(value?.text || '').trim();
      if (!!url === !!text) throw Error('Provide either a public URL or text to screen');
      const request = url ? { url: publicWebUrl(url), mode: 'full', max_chars: 12000 } : { text: text.slice(0, 12000), mode: 'full', input_type: 'text' };
      return screenedEvidence(await call('screen', request, 35_000));
    },
  };
}
