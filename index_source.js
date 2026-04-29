/**
 * rw2026-bestip - Xray + Cloudflare Tunnel with Deep Edgetunnel Best-IP Integration
 *
 * 核心特性：
 * 1. 多源优选IP获取（支持多个edgetunnel Worker API）
 * 2. TCP延迟测速，自动选择最快入口
 * 3. 定时刷新（可配置间隔），订阅自动更新
 * 4. /bestip 状态面板，实时查看测速结果
 *
 * 架构：客户端 → 优选IP(edgetunnel测速) → CF固定隧道 → VPS(Xray) → 出口
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const express = require('express');
const axios = require('axios');
const { execSync, exec } = require('child_process');

const app = express();

// ========== 1. 环境变量 ==========
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const FILE_PATH = process.env.FILE_PATH || './tmp';
const UUID = process.env.UUID || '';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const ARGO_PORT = process.env.ARGO_PORT || '8001';
const CFIP = process.env.CFIP || 'cdns.doon.eu.org';
const CFPORT = process.env.CFPORT || '443';
const NAME = process.env.NAME || '';
const SUB_PATH = process.env.SUB_PATH || 'sub';
const UPLOAD_URL = process.env.UPLOAD_URL || '';
const PROJECT_URL = process.env.PROJECT_URL || '';

// 多源优选API配置（逗号分隔多个URL）
const BESTIP_APIS = (process.env.BESTIP_APIS || process.env.EDGETUNNEL_API || '').split(',').map(s => s.trim()).filter(Boolean);
// 测速间隔（毫秒，默认4小时）
const BESTIP_INTERVAL = parseInt(process.env.BESTIP_INTERVAL) || 4 * 60 * 60 * 1000;
// 测速并发数
const BESTIP_CONCURRENCY = parseInt(process.env.BESTIP_CONCURRENCY) || 10;
// 测速超时（毫秒）
const BESTIP_TIMEOUT = parseInt(process.env.BESTIP_TIMEOUT) || 3000;
// 保留前N个最快IP
const BESTIP_TOP_N = parseInt(process.env.BESTIP_TOP_N) || 3;

// ========== 2. 全局状态 ==========
let xrayProcess = null;
let cloudflaredProcess = null;
let currentBestIP = CFIP;
let bestIPResults = [];     // [{ip, port, latency, source, testedAt}]
let lastTestTime = 0;
let testRunning = false;

// ========== 3. 日志 ==========
function log(prefix, msg, type = 'info') {
  const c = { info: '\x1b[36m', success: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };
  console.log(`${c[type]}${new Date().toISOString()} [${prefix}] ${msg}${c.reset}`);
}

// ========== 4. 优选IP核心模块 ==========

// TCP延迟测试单个IP
function testTCPLatency(host, port, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve({ host, port, latency, ok: true });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ host, port, latency: timeout, ok: false }); });
    socket.on('error', () => { socket.destroy(); resolve({ host, port, latency: timeout, ok: false }); });
    socket.connect(parseInt(port) || 443, host);
  });
}

// 从单个API源获取IP列表
async function fetchIPsFromSource(apiUrl) {
  try {
    log('FETCH', `从 ${apiUrl} 获取IP列表...`, 'info');
    const resp = await axios.get(apiUrl, { timeout: 10000, headers: { 'User-Agent': 'rw2026-bestip/1.0' } });
    let data = typeof resp.data === 'string' ? resp.data.trim() : JSON.stringify(resp.data);

    // 尝试base64解码
    if (data.length > 50 && !data.includes('\n') && !data.includes('://')) {
      try { data = Buffer.from(data, 'base64').toString('utf8'); } catch (e) {}
    }

    const ips = [];
    // 解析vless/vmess/trojan链接中的地址
    const linkRegex = /(?:vless|vmess|trojan):\/\/[^@]*@([^:]+):(\d+)/g;
    let m;
    while ((m = linkRegex.exec(data)) !== null) {
      ips.push({ ip: m[1], port: m[2], source: apiUrl });
    }
    // 解析纯文本IP:Port列表
    if (ips.length === 0) {
      for (const line of data.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split(':');
        const ip = parts[0].trim();
        const port = parts[1]?.trim() || '443';
        if (/^[\d.]+$/.test(ip) || /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(ip)) {
          ips.push({ ip, port, source: apiUrl });
        }
      }
    }
    log('FETCH', `从 ${apiUrl} 获取到 ${ips.length} 个IP`, 'success');
    return ips;
  } catch (err) {
    log('ERROR', `获取 ${apiUrl} 失败: ${err.message}`, 'error');
    return [];
  }
}

// 并发测速
async function testIPsBatch(ipList, concurrency, timeout) {
  const results = [];
  for (let i = 0; i < ipList.length; i += concurrency) {
    const batch = ipList.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(item => testTCPLatency(item.ip, item.port, timeout).then(r => ({ ...r, source: item.source })))
    );
    results.push(...batchResults);
  }
  return results.filter(r => r.ok).sort((a, b) => a.latency - b.latency);
}

// 完整测速流程
async function runBestIPTest() {
  if (testRunning) { log('BESTIP', '测速正在进行中，跳过', 'warn'); return; }
  if (BESTIP_APIS.length === 0) { log('BESTIP', '未配置BESTIP_APIS，使用静态CFIP', 'warn'); return; }

  testRunning = true;
  log('BESTIP', '========== 开始优选IP测速 ==========', 'info');
  const startTime = Date.now();

  try {
    // 1. 从所有API源收集IP
    const allFetches = await Promise.all(BESTIP_APIS.map(url => fetchIPsFromSource(url)));
    let allIPs = allFetches.flat();
    // 去重
    const seen = new Set();
    allIPs = allIPs.filter(item => {
      const key = `${item.ip}:${item.port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    log('BESTIP', `共收集到 ${allIPs.length} 个唯一IP，开始测速...`, 'info');

    if (allIPs.length === 0) {
      log('BESTIP', '未获取到任何IP，保持当前配置', 'warn');
      return;
    }

    // 2. TCP延迟测速
    const results = await testIPsBatch(allIPs, BESTIP_CONCURRENCY, BESTIP_TIMEOUT);
    log('BESTIP', `测速完成，${results.length}/${allIPs.length} 个IP可达`, 'success');

    if (results.length > 0) {
      bestIPResults = results.slice(0, BESTIP_TOP_N).map(r => ({
        ip: r.host, port: r.port, latency: r.latency, source: r.source, testedAt: new Date().toISOString()
      }));
      const oldIP = currentBestIP;
      currentBestIP = bestIPResults[0].ip;
      lastTestTime = Date.now();

      if (oldIP !== currentBestIP) {
        log('BESTIP', `*** 最佳IP已更新: ${oldIP} → ${currentBestIP} (${bestIPResults[0].latency}ms) ***`, 'success');
        // 重新生成订阅
        const argoDomain = ARGO_DOMAIN || await extractDomains();
        if (argoDomain) await generateLinks(argoDomain, currentBestIP);
      } else {
        log('BESTIP', `最佳IP未变: ${currentBestIP} (${bestIPResults[0].latency}ms)`, 'info');
      }

      // 打印TOP N
      bestIPResults.forEach((r, i) => {
        log('BESTIP', `  #${i + 1}: ${r.ip}:${r.port} - ${r.latency}ms (${r.source})`, 'info');
      });
    }
  } catch (err) {
    log('ERROR', `测速异常: ${err.message}`, 'error');
  } finally {
    testRunning = false;
    log('BESTIP', `测速耗时 ${Date.now() - startTime}ms`, 'info');
  }
}

// ========== 5. HTTP路由 ==========

app.get('/', (req, res) => res.send('rw2026-bestip running'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', bestIP: currentBestIP, lastTest: lastTestTime ? new Date(lastTestTime).toISOString() : 'never' });
});

// 优选IP状态面板
app.get('/bestip', (req, res) => {
  const nextTest = lastTestTime ? new Date(lastTestTime + BESTIP_INTERVAL).toISOString() : 'pending';
  res.json({
    currentBestIP,
    cfipFallback: CFIP,
    apiSources: BESTIP_APIS,
    testInterval: `${BESTIP_INTERVAL / 60000} min`,
    lastTestTime: lastTestTime ? new Date(lastTestTime).toISOString() : 'never',
    nextTestTime: nextTest,
    testRunning,
    topResults: bestIPResults
  });
});

// 手动触发测速
app.get('/bestip/test', async (req, res) => {
  res.json({ message: 'Test triggered', running: testRunning });
  if (!testRunning) runBestIPTest();
});

// ========== 6. Xray配置生成 ==========

async function getMetaInfo() {
  try {
    const r = await axios.get('https://ipapi.co/json/', { timeout: 5000 });
    return r.data.org || r.data.isp || 'Unknown';
  } catch (e) {
    try {
      const r = await axios.get('http://ip-api.com/json/', { timeout: 5000 });
      return r.data.isp || 'Unknown';
    } catch (e2) { return 'Unknown'; }
  }
}

async function generateConfig() {
  const config = {
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
    inbounds: [
      {
        port: parseInt(ARGO_PORT), protocol: 'vless',
        settings: {
          clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: 'none',
          fallbacks: [
            { dest: '127.0.0.1:3001' },
            { dest: '127.0.0.1:3002', path: '/vless-argo' },
            { dest: '127.0.0.1:3003', path: '/vmess-argo' },
            { dest: '127.0.0.1:3004', path: '/trojan-argo' }
          ]
        },
        streamSettings: { network: 'tcp', security: 'none' }
      },
      { port: 3001, listen: '127.0.0.1', protocol: 'vless', settings: { clients: [{ id: UUID }], decryption: 'none' }, streamSettings: { network: 'tcp' } },
      { port: 3002, listen: '127.0.0.1', protocol: 'vless', settings: { clients: [{ id: UUID }], decryption: 'none' }, streamSettings: { network: 'ws', wsSettings: { path: '/vless-argo' } } },
      { port: 3003, listen: '127.0.0.1', protocol: 'vmess', settings: { clients: [{ id: UUID, alterId: 0 }] }, streamSettings: { network: 'ws', wsSettings: { path: '/vmess-argo' } } },
      { port: 3004, listen: '127.0.0.1', protocol: 'trojan', settings: { clients: [{ password: UUID }] }, streamSettings: { network: 'ws', wsSettings: { path: '/trojan-argo' } } }
    ],
    dns: { servers: ['https+local://8.8.8.8/dns-query'] },
    outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'block' }]
  };
  fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config, null, 2));
  log('CONFIG', 'Xray配置已生成', 'success');
}

// ========== 7. 下载二进制 ==========

function getDownloadInfo() {
  const arch = os.arch();
  const m = { x64: ['64', 'amd64'], arm64: ['arm64-v8a', 'arm64'], arm: ['armv7l', 'arm'], ia32: ['32', '386'] };
  const [xm, ca] = m[arch] || m.x64;
  return {
    xrayURL: `https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${xm}.zip`,
    cloudflaredURL: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ca}`,
    xrayMachine: xm
  };
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    exec(`curl -L --connect-timeout 30 --max-time 300 -o "${dest}" "${url}"`, (err) => {
      if (err) reject(new Error(`下载失败: ${url}`));
      else resolve(dest);
    });
  });
}

async function downloadFilesAndRun(callback) {
  const { xrayURL, cloudflaredURL, xrayMachine } = getDownloadInfo();
  const xrayZip = path.join(FILE_PATH, `Xray-linux-${xrayMachine}.zip`);
  const cfPath = path.join(FILE_PATH, 'cloudflared');
  try {
    await downloadFile(xrayURL, xrayZip);
    try { execSync(`unzip -o "${xrayZip}" -d "${FILE_PATH}"`, { stdio: 'pipe' }); } catch (e) {}
    try { execSync(`chmod +x "${path.join(FILE_PATH, 'xray')}"`); } catch (e) {}
    await downloadFile(cloudflaredURL, cfPath);
    execSync(`chmod +x "${cfPath}"`);
    log('DOWNLOAD', '二进制文件准备完毕', 'success');
    if (callback) await callback();
  } catch (err) {
    log('ERROR', `下载失败: ${err.message}`, 'error');
    process.exit(1);
  }
}

// ========== 8. 隧道 ==========

function argoType() {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    if (ARGO_AUTH.includes('TunnelSecret')) {
      try {
        const ts = JSON.parse(ARGO_AUTH);
        fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), JSON.stringify({ Tunnel: ts.Tunnel, Credentials: ts.Credentials }, null, 2));
        fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), `tunnel: ${ts.Tunnel}\ncredentials-file: ${path.join(FILE_PATH, 'tunnel.json')}\n`);
        log('ARGO', '固定隧道配置已写入', 'success');
      } catch (e) { log('ERROR', `ARGO_AUTH解析失败: ${e.message}`, 'error'); }
    } else {
      log('ARGO', '使用Token连接隧道', 'info');
    }
  } else {
    log('WARN', '未设置ARGO配置，使用临时隧道', 'warn');
  }
}

async function extractDomains() {
  if (ARGO_DOMAIN) { log('DOMAIN', `固定域名: ${ARGO_DOMAIN}`, 'info'); return ARGO_DOMAIN; }
  const bootLog = path.join(FILE_PATH, 'boot.log');
  for (let i = 1; i <= 3; i++) {
    log('DOMAIN', `尝试 ${i}/3 解析域名...`, 'info');
    try {
      if (fs.existsSync(bootLog)) {
        const content = fs.readFileSync(bootLog, 'utf-8');
        const m = content.match(/https?:\/\/([a-z0-9]+\.trycloudflare\.com)/);
        if (m) { log('SUCCESS', `临时域名: ${m[1]}`, 'success'); return m[1]; }
      }
    } catch (e) {}
    if (i < 3) { try { execSync('pkill cloudflared', { stdio: 'pipe' }); } catch (e) {} await new Promise(r => setTimeout(r, 3000)); }
  }
  log('ERROR', '无法获取域名', 'error');
  return null;
}

// ========== 9. 订阅生成 ==========

async function generateLinks(argoDomain, entryIP) {
  const ISP = await getMetaInfo();
  const nodeName = NAME ? `${NAME}-${ISP}` : ISP;
  const ip = entryIP || currentBestIP;
  log('GEN', `生成订阅，入口: ${ip}`, 'info');

  const vless = `vless://${UUID}@${ip}:${CFPORT}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=${encodeURIComponent('/vless-argo?ed=2560')}#${encodeURIComponent(nodeName)}`;
  const vmessObj = { v: '2', ps: nodeName, add: ip, port: CFPORT, id: UUID, aid: 0, net: 'ws', type: 'none', host: argoDomain, path: '/vmess-argo', tls: 'tls', sni: argoDomain, fp: 'firefox' };
  const vmess = `vmess://${Buffer.from(JSON.stringify(vmessObj)).toString('base64')}`;
  const trojan = `trojan://${UUID}@${ip}:${CFPORT}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=${encodeURIComponent('/trojan-argo?ed=2560')}#${encodeURIComponent(nodeName)}`;

  // 如果有多个优选IP结果，为每个生成节点
  let allLinks = `${vless}\n${vmess}\n${trojan}\n`;
  if (bestIPResults.length > 1) {
    for (let i = 1; i < bestIPResults.length; i++) {
      const r = bestIPResults[i];
      const suffix = `${nodeName}-${r.latency}ms`;
      allLinks += `vless://${UUID}@${r.ip}:${CFPORT}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=${encodeURIComponent('/vless-argo?ed=2560')}#${encodeURIComponent(suffix)}\n`;
    }
  }

  const subB64 = Buffer.from(allLinks).toString('base64');
  fs.writeFileSync(path.join(FILE_PATH, 'sub.txt'), subB64);
  log('FILE', 'sub.txt已更新', 'success');

  console.log('\n========== 订阅(Base64) ==========');
  console.log(subB64);
  console.log('===================================\n');

  // 注册/更新路由
  app.get(`/${SUB_PATH}`, (req, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    // 实时读取最新的sub.txt
    try {
      res.send(fs.readFileSync(path.join(FILE_PATH, 'sub.txt'), 'utf-8'));
    } catch (e) {
      res.send(subB64);
    }
  });
}

// ========== 10. 清理 ==========

function cleanupOldFiles() {
  if (!fs.existsSync(FILE_PATH)) { fs.mkdirSync(FILE_PATH, { recursive: true }); return; }
  for (const f of fs.readdirSync(FILE_PATH)) {
    try { fs.unlinkSync(path.join(FILE_PATH, f)); } catch (e) {}
  }
}

function cleanFiles() {
  setTimeout(() => {
    try {
      for (const pat of ['boot.log', 'config.json', 'Xray-linux-']) {
        for (const f of fs.readdirSync(FILE_PATH)) {
          if (f.includes(pat)) { try { fs.unlinkSync(path.join(FILE_PATH, f)); } catch (e) {} }
        }
      }
    } catch (e) {}
    log('START', 'App is running', 'success');
  }, 90000);
}

// ========== 11. 主流程 ==========

async function startserver() {
  log('START', '========== rw2026-bestip 启动 ==========', 'info');
  log('CONFIG', `UUID: ${(UUID || '').substring(0, 8)}...`, 'info');
  log('CONFIG', `ARGO_DOMAIN: ${ARGO_DOMAIN || '临时隧道'}`, 'info');
  log('CONFIG', `优选API源: ${BESTIP_APIS.length}个`, 'info');
  log('CONFIG', `测速间隔: ${BESTIP_INTERVAL / 60000}分钟`, 'info');

  cleanupOldFiles();
  argoType();

  await downloadFilesAndRun(async () => {
    await generateConfig();

    // 启动Xray
    const xrayPath = path.join(FILE_PATH, 'xray');
    xrayProcess = exec(`${xrayPath} -c ${path.join(FILE_PATH, 'config.json')}`, { cwd: FILE_PATH });
    xrayProcess.on('error', err => log('XRAY', `错误: ${err.message}`, 'error'));
    log('XRAY', `Xray已启动 (PID: ${xrayProcess.pid})`, 'success');

    await new Promise(r => setTimeout(r, 2000));

    // 启动Cloudflared
    const cfPath = path.join(FILE_PATH, 'cloudflared');
    let cfArgs = `tunnel --no-autoupdate --url http://localhost:${ARGO_PORT} --logfile ${path.join(FILE_PATH, 'boot.log')} --metrics localhost:20000`;
    if (ARGO_AUTH) {
      if (ARGO_AUTH.includes('TunnelSecret')) cfArgs = `tunnel --no-autoupdate --config ${path.join(FILE_PATH, 'tunnel.yml')}`;
      else cfArgs += ` --token ${ARGO_AUTH}`;
    }
    cloudflaredProcess = exec(`${cfPath} ${cfArgs}`, { cwd: FILE_PATH });
    cloudflaredProcess.on('error', err => log('TUNNEL', `错误: ${err.message}`, 'error'));
    log('TUNNEL', 'Cloudflared已启动', 'success');

    await new Promise(r => setTimeout(r, 5000));

    const argoDomain = await extractDomains();
    if (!argoDomain) { log('ERROR', '无法获取域名，退出', 'error'); process.exit(1); }

    // 首次优选测速
    await runBestIPTest();

    // 生成订阅
    await generateLinks(argoDomain, currentBestIP);

    // 定时测速
    setInterval(() => runBestIPTest(), BESTIP_INTERVAL);
    log('BESTIP', `定时测速已启动，间隔${BESTIP_INTERVAL / 60000}分钟`, 'success');

    cleanFiles();
  });
}

// ========== 12. 信号处理 ==========

function handleShutdown(sig) {
  log('SHUTDOWN', `收到${sig}，关闭服务...`, 'warn');
  try { if (xrayProcess) xrayProcess.kill(); } catch (e) {}
  try { if (cloudflaredProcess) cloudflaredProcess.kill(); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// ========== 13. 启动 ==========

app.listen(PORT, '0.0.0.0', () => log('HTTP', `服务器: 0.0.0.0:${PORT}`, 'success'));
startserver().catch(err => { log('FATAL', `启动失败: ${err.message}`, 'error'); process.exit(1); });
