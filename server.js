const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const JavaScriptObfuscator = require('javascript-obfuscator');

const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── SSE ────────────────────────────────────────────────────────────────────
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── OBFUSCATION ─────────────────────────────────────────────────────────────
const SKIP_FILES = new Set(['settings.js','config.js','settings.ts','config.ts']);
const SKIP_DIRS  = new Set(['node_modules','.git','dist','build','.next','out']);

function obfuscate(code) {
  return JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    selfDefending: true,
    disableConsoleOutput: false,
    transformObjectKeys: true,
    identifierNamesGenerator: 'hexadecimal',
    rotateStringArray: true
  }).getObfuscatedCode();
}

async function processRepo(dir, banner, log) {
  const stats = { total: 0, obfuscated: 0, skipped: 0, failed: 0, files: [] };

  async function walk(cur) {
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(cur, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(fp); continue; }
      const isJS = e.name.endsWith('.js');
      const isTS = e.name.endsWith('.ts') && !e.name.endsWith('.d.ts');
      if (!isJS && !isTS) continue;
      stats.total++;
      const rel = fp.replace(dir + path.sep, '');
      if (SKIP_FILES.has(e.name)) {
        stats.skipped++;
        stats.files.push({ path: rel, status: 'skipped' });
        log('skip', `Skipped: ${rel}`);
        continue;
      }
      try {
        // Read raw — no modifications, no stripping, just encrypt as-is
        const code = await fsp.readFile(fp, 'utf8');
        const out = banner + obfuscate(code);
        await fsp.writeFile(fp, out, 'utf8');
        stats.obfuscated++;
        stats.files.push({ path: rel, status: 'success' });
        log('ok', `Encrypted: ${rel}`);
      } catch (err) {
        stats.failed++;
        stats.files.push({ path: rel, status: 'failed', error: err.message });
        log('fail', `Failed: ${rel} — ${err.message}`);
      }
    }
  }

  await walk(dir);
  return stats;
}

// ─── ROUTE ───────────────────────────────────────────────────────────────────
app.post('/api/obfuscate', async (req, res) => {
  const { sourceUrl, token, targetUrl, username, email, banner: customBanner } = req.body;

  if (!sourceUrl || !token || !targetUrl || !username || !email) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const log = (type, msg) => sse(res, 'log', { type, msg });
  const tmpDir = path.join(os.tmpdir(), `subzero_${Date.now()}`);
  const banner = (customBanner?.trim() || '// Powered by MR FRANK | SubZero MD V7 | @GlobalTechInfo') + '\n';

  function authUrl(url) {
    try {
      const u = new URL(url);
      u.username = token;
      u.password = '';
      return u.toString();
    } catch {
      return url.replace('https://', `https://${token}@`);
    }
  }

  function sanitize(str) {
    return str.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
  }

  try {
    // 1 — Clone
    log('step', '📦 Cloning source repository...');
    execSync(`git clone --depth=1 "${authUrl(sourceUrl)}" "${tmpDir}"`, { timeout: 90000, stdio: 'pipe' });
    log('ok', 'Repository cloned.');

    // 2 — Git identity
    log('step', '⚙️  Setting git identity...');
    execSync(`git -C "${tmpDir}" config user.name "${username}"`, { stdio: 'pipe' });
    execSync(`git -C "${tmpDir}" config user.email "${email}"`, { stdio: 'pipe' });
    log('ok', `Identity set: ${username} <${email}>`);

    // 3 — Obfuscate
    log('step', '🔐 Encrypting JS/TS files...');
    const results = await processRepo(tmpDir, banner, log);
    log('step', `✅ Encryption done — ${results.obfuscated} encrypted, ${results.skipped} skipped, ${results.failed} failed.`);

    // 4 — Commit
    log('step', '📝 Committing changes...');
    execSync(`git -C "${tmpDir}" add -A`, { stdio: 'pipe' });
    try {
      execSync(`git -C "${tmpDir}" commit -m "chore: obfuscated by MR FRANK // SubZero MD V7"`, { stdio: 'pipe' });
      log('ok', 'Commit created.');
    } catch {
      log('info', 'Nothing new to commit — force-pushing current state.');
    }

    // 5 — Force push (with large buffer + no-thin to avoid pack errors on big repos)
    log('step', '🚀 Force-pushing to target repository...');
    execSync(`git -C "${tmpDir}" remote set-url origin "${authUrl(targetUrl)}"`, { stdio: 'pipe' });

    // Bump pack limits so GitHub doesn't reject large obfuscated payloads
    execSync(`git -C "${tmpDir}" config pack.windowMemory 256m`, { stdio: 'pipe' });
    execSync(`git -C "${tmpDir}" config pack.packSizeLimit 256m`, { stdio: 'pipe' });
    execSync(`git -C "${tmpDir}" config pack.threads 1`, { stdio: 'pipe' });
    execSync(`git -C "${tmpDir}" config http.postBuffer 524288000`, { stdio: 'pipe' });

    // Try push — if it fails due to pack issues, repack and retry once
    try {
      execSync(`git -C "${tmpDir}" push origin HEAD --force --no-thin`, { timeout: 120000, stdio: 'pipe' });
    } catch (pushErr) {
      log('info', 'First push attempt failed, repacking and retrying...');
      execSync(`git -C "${tmpDir}" repack -a -d -f --depth=1 --window=1`, { timeout: 60000, stdio: 'pipe' });
      execSync(`git -C "${tmpDir}" push origin HEAD --force --no-thin`, { timeout: 120000, stdio: 'pipe' });
    }
    log('ok', '🎉 Force push successful!');

    // 6 — Done
    sse(res, 'done', {
      total: results.total,
      obfuscated: results.obfuscated,
      skipped: results.skipped,
      failed: results.failed,
      files: results.files
    });

  } catch (err) {
    const msg = sanitize(err.stderr?.toString() || err.message || String(err));
    log('error', `❌ ${msg}`);
    sse(res, 'error', { message: msg });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.end();
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔐 MR FRANK Obfuscator v2 running on :${PORT}`));
