'use strict';

const express = require('express');
const net = require('net');
const crypto = require('crypto');

const app = express();

const CONFIG = {
  port: parseInt(process.env.PORT || process.env.SERVER_PORT || '3000', 10),
  uuid: process.env.UUID || '',
  cfIp: process.env.CFIP || 'www.visa.com.sg',
  cfPort: parseInt(process.env.CFPORT || '443', 10),
  subPath: normalizePath(process.env.SUB_PATH || 'sub'),
  bestIpApis: parseList(process.env.BESTIP_APIS || process.env.EDGETUNNEL_API || ''),
  bestIpIntervalMs: parseInt(process.env.BESTIP_INTERVAL || String(4 * 60 * 60 * 1000), 10),
  bestIpConcurrency: parseInt(process.env.BESTIP_CONCURRENCY || '10', 10),
  bestIpTimeoutMs: parseInt(process.env.BESTIP_TIMEOUT || '3000', 10),
  bestIpTopN: parseInt(process.env.BESTIP_TOP_N || '3', 10),
};

const state = {
  startedAt: new Date(),
  currentBestIp: CONFIG.cfIp,
  bestIpResults: [],
  lastTestTime: null,
  testRunning: false,
};

function log(level, message, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  console.log(JSON.stringify(entry));
}

function parseList(value) {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizePath(value) {
  return String(value || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '') || 'sub';
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateConfig() {
  const errors = [];

  if (!Number.isInteger(CONFIG.port) || CONFIG.port < 1 || CONFIG.port > 65535) {
    errors.push('PORT / SERVER_PORT must be a valid TCP port.');
  }

  if (CONFIG.uuid && !isValidUuid(CONFIG.uuid)) {
    errors.push('UUID is present but invalid.');
  }

  if (!Number.isInteger(CONFIG.cfPort) || CONFIG.cfPort < 1 || CONFIG.cfPort > 65535) {
    errors.push('CFPORT must be a valid TCP port.');
  }

  if (!Number.isInteger(CONFIG.bestIpIntervalMs) || CONFIG.bestIpIntervalMs < 60_000) {
    errors.push('BESTIP_INTERVAL must be at least 60000 ms.');
  }

  if (!Number.isInteger(CONFIG.bestIpConcurrency) || CONFIG.bestIpConcurrency < 1 || CONFIG.bestIpConcurrency > 100) {
    errors.push('BESTIP_CONCURRENCY must be between 1 and 100.');
  }

  if (!Number.isInteger(CONFIG.bestIpTimeoutMs) || CONFIG.bestIpTimeoutMs < 500 || CONFIG.bestIpTimeoutMs > 60_000) {
    errors.push('BESTIP_TIMEOUT must be between 500 and 60000 ms.');
  }

  if (!Number.isInteger(CONFIG.bestIpTopN) || CONFIG.bestIpTopN < 1 || CONFIG.bestIpTopN > 20) {
    errors.push('BESTIP_TOP_N must be between 1 and 20.');
  }

  return errors;
}

function testTcpLatency(host, port, timeoutMs) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const socket = new net.Socket();

    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;

      socket.destroy();
      resolve(result);
    }

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      finish({
        host,
        port,
        ok: true,
        latencyMs: Date.now() - startedAt,
      });
    });

    socket.once('timeout', () => {
      finish({
        host,
        port,
        ok: false,
        error: 'timeout',
      });
    });

    socket.once('error', error => {
      finish({
        host,
        port,
        ok: false,
        error: error.message,
      });
    });

    socket.connect(port, host);
  });
}

function parseCandidateHosts(text, source) {
  const results = [];
  const seen = new Set();

  const lines = String(text || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([a-zA-Z0-9.-]+|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);

    if (!match) continue;

    const host = match[1];
    const port = parseInt(match[2], 10);

    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

    const key = `${host}:${port}`;

    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      host,
      port,
      source,
    });
  }

  return results;
}

async function fetchCandidateHostsFromApi(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      'user-agent': 'auditable-node-service/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`API returned HTTP ${response.status}`);
  }

  const text = await response.text();

  return parseCandidateHosts(text, url);
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = [];
  let index = 0;

  async function next() {
    while (index < items.length) {
      const current = items[index++];
      results.push(await worker(current));
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => next()
  );

  await Promise.all(workers);

  return results;
}

async function runBestIpTest() {
  if (state.testRunning) {
    return {
      skipped: true,
      reason: 'test_already_running',
    };
  }

  if (CONFIG.bestIpApis.length === 0) {
    return {
      skipped: true,
      reason: 'no_best_ip_apis_configured',
    };
  }

  state.testRunning = true;

  try {
    log('info', 'Starting best IP test.');

    const apiResults = await Promise.allSettled(
      CONFIG.bestIpApis.map(fetchCandidateHostsFromApi)
    );

    const candidates = [];
    const seen = new Set();

    for (const result of apiResults) {
      if (result.status === 'rejected') {
        log('warn', 'Failed to fetch candidate hosts.', {
          error: result.reason.message,
        });
        continue;
      }

      for (const candidate of result.value) {
        const key = `${candidate.host}:${candidate.port}`;

        if (seen.has(key)) continue;
        seen.add(key);

        candidates.push(candidate);
      }
    }

    if (candidates.length === 0) {
      log('warn', 'No candidate hosts found.');
      return {
        skipped: true,
        reason: 'no_candidates',
      };
    }

    const tested = await runWithConcurrency(
      candidates,
      CONFIG.bestIpConcurrency,
      async candidate => {
        const result = await testTcpLatency(
          candidate.host,
          candidate.port,
          CONFIG.bestIpTimeoutMs
        );

        return {
          ...candidate,
          ...result,
        };
      }
    );

    const successful = tested
      .filter(item => item.ok)
      .sort((a, b) => a.latencyMs - b.latencyMs);

    if (successful.length === 0) {
      log('warn', 'No reachable candidate hosts.');
      return {
        skipped: true,
        reason: 'no_reachable_candidates',
      };
    }

    state.bestIpResults = successful.slice(0, CONFIG.bestIpTopN).map(item => ({
      host: item.host,
      port: item.port,
      latencyMs: item.latencyMs,
      source: item.source,
      testedAt: new Date().toISOString(),
    }));

    state.currentBestIp = state.bestIpResults[0].host;
    state.lastTestTime = new Date();

    log('info', 'Best IP test completed.', {
      currentBestIp: state.currentBestIp,
      bestPort: state.bestIpResults[0].port,
      latencyMs: state.bestIpResults[0].latencyMs,
    });

    return {
      skipped: false,
      results: state.bestIpResults,
    };
  } finally {
    state.testRunning = false;
  }
}

app.get('/', (req, res) => {
  res.type('text/plain').send('OK');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    startedAt: state.startedAt.toISOString(),
  });
});

app.get('/status', (req, res) => {
  res.json({
    currentBestIp: state.currentBestIp,
    fallbackIp: CONFIG.cfIp,
    fallbackPort: CONFIG.cfPort,
    lastTestTime: state.lastTestTime ? state.lastTestTime.toISOString() : null,
    testRunning: state.testRunning,
    topResults: state.bestIpResults,
    bestIpApisConfigured: CONFIG.bestIpApis.length,
  });
});

app.post('/best-ip/test', async (req, res) => {
  try {
    const result = await runBestIpTest();
    res.json(result);
  } catch (error) {
    log('error', 'Best IP test failed.', {
      error: error.message,
    });

    res.status(500).json({
      error: error.message,
    });
  }
});

app.get(`/${CONFIG.subPath}`, (req, res) => {
  res.type('text/plain').send(
    [
      'This safe rewrite does not generate proxy subscription links.',
      'It only exposes validated status and best-IP test results.',
      '',
      `currentBestIp=${state.currentBestIp}`,
      `fallback=${CONFIG.cfIp}:${CONFIG.cfPort}`,
    ].join('\n')
  );
});

function startScheduler() {
  if (CONFIG.bestIpApis.length === 0) {
    log('info', 'Best IP scheduler disabled because no APIs are configured.');
    return;
  }

  setInterval(() => {
    runBestIpTest().catch(error => {
      log('error', 'Scheduled best IP test failed.', {
        error: error.message,
      });
    });
  }, CONFIG.bestIpIntervalMs);
}

function start() {
  const configErrors = validateConfig();

  if (configErrors.length > 0) {
    for (const error of configErrors) {
      log('error', error);
    }

    process.exit(1);
  }

  app.listen(CONFIG.port, '0.0.0.0', () => {
    log('info', 'Server started.', {
      port: CONFIG.port,
      subPath: `/${CONFIG.subPath}`,
      bestIpApisConfigured: CONFIG.bestIpApis.length,
    });
  });

  startScheduler();
}

process.on('SIGINT', () => {
  log('info', 'Received SIGINT. Exiting.');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('info', 'Received SIGTERM. Exiting.');
  process.exit(0);
});

start();
