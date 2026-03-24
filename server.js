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

function stripTS(filePath) {
  let code = fs.readFileSync(filePath, 'utf8');

  // 1. Remove import type { ... } from '...'  and  export type { ... } from '...'
  code = code.replace(/^[ \t]*(import|export)\s+type\s+\{[^}]*\}\s*from\s*['"][^'"]*['"]\s*;?/gm, '');

  // 2. Remove  import type Foo from '...'
  code = code.replace(/^[ \t]*import\s+type\s+\w+\s+from\s*['"][^'"]*['"]\s*;?/gm, '');

  // 3. Remove standalone  export type Foo = ...;
  code = code.replace(/^[ \t]*export\s+type\s+\w[^=\n]*=[^\n]*(\n|;)/gm, '');

  // 4. Remove type alias declarations:  type Foo = ...;
  code = code.replace(/^[ \t]*type\s+\w[\w\s<>,|&=\[\]{}()*?:\.]*;/gm, '');

  // 5. Remove interface declarations (multi-line)
  code = code.replace(/^[ \t]*(export\s+)?(declare\s+)?interface\s+\w[\w\s<>,]*\{[^}]*\}/gms, '');

  // 6. Remove enum declarations — convert to empty  (simple approach)
  code = code.replace(/^[ \t]*(export\s+)?(const\s+)?enum\s+\w+\s*\{[^}]*\}/gms, '');

  // 7. Remove decorators  @Something(...)  or  @Something
  code = code.replace(/^[ \t]*@\w+(\([\s\S]*?\))?\s*$/gm, '');

  // 8. Remove generic type params from function/class declarations: <T>, <T extends X>, <A, B>
  code = code.replace(/<[A-Za-z_$][\w\s,|&<>?:\[\]\.=]*>/g, '');

  // 9. Remove parameter type annotations:  (x: string, y: number)
  //    Handle  param: Type  param?: Type  param!: Type
  code = code.replace(/(\w)\s*[?!]?\s*:\s*[\w\[\]<>|&{}'"`.,\s?!]+(?=[,)=\n;{])/g, '$1');

  // 10. Remove return type annotations after ):  ): ReturnType {
  code = code.replace(/\)\s*:\s*[\w\[\]<>|&{}'"`.,\s?!]+(?=\s*[\{;])/g, ')');

  // 11. Remove  as Type  casts
  code = code.replace(/\s+as\s+[\w\[\]<>|&.]+/g, '');

  // 12. Remove  !  non-null assertions  foo!.bar  →  foo.bar
  code = code.replace(/!(?=\.)/g, '');

  // 13. Remove  declare  keyword lines
  code = code.replace(/^[ \t]*declare\s+.+;?$/gm, '');

  // 14. Remove  abstract  keyword
  code = code.replace(/\babstract\s+/g, '');

  // 15. Remove  readonly  keyword
  code = code.replace(/\breadonly\s+/g, '');

  // 16. Remove access modifiers on class members
  code = code.replace(/\b(public|private|protected|override)\s+/g, '');

  // 17. Convert  import { Foo, type Bar } from '...'  →  import { Foo } from '...'
  code = code.replace(/,?\s*type\s+\w+/g, '');

  // 18. Convert ES module imports to require (simple named + default)
  code = code.replace(/^[ \t]*import\s+\*\s+as\s+(\w+)\s+from\s*(['"][^'"]*['"])\s*;?/gm,
    'const $1 = require($2);');
  code = code.replace(/^[ \t]*import\s+(\w+)\s*,\s*\{([^}]*)\}\s+from\s*(['"][^'"]*['"])\s*;?/gm,
    'const $1 = require($3); const { $2 } = require($3);');
  code = code.replace(/^[ \t]*import\s+\{([^}]*)\}\s+from\s*(['"][^'"]*['"])\s*;?/gm,
    'const { $1 } = require($2);');
  code = code.replace(/^[ \t]*import\s+(\w+)\s+from\s*(['"][^'"]*['"])\s*;?/gm,
    'const $1 = require($2);');
  code = code.replace(/^[ \t]*import\s+(['"][^'"]*['"])\s*;?/gm,
    'require($1);');

  // 19. Convert export default
  code = code.replace(/^[ \t]*export\s+default\s+/gm, 'module.exports = ');

  // 20. Convert named exports:  export { foo, bar }
  code = code.replace(/^[ \t]*export\s+\{([^}]*)\}\s*;?/gm, (_, names) => {
    return names.split(',').map(n => {
      const name = n.trim().split(/\s+as\s+/).pop().trim();
      const orig = n.trim().split(/\s+as\s+/)[0].trim();
      return `module.exports.${name} = ${orig};`;
    }).join('\n');
  });

  // 21. Convert  export const/function/class  →  strip export keyword
  code = code.replace(/^[ \t]*export\s+(const|let|var|function|class|async)/gm, '$1');

  return code;
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
        let code = isTS ? stripTS(fp) : await fsp.readFile(fp, 'utf8');
        if (!code || !code.trim()) code = '// stripped';
        const out = banner + obfuscate(code);
        const outPath = isTS ? fp.replace(/\.ts$/, '.js') : fp;
        await fsp.writeFile(outPath, out, 'utf8');
        if (isTS && outPath !== fp) await fsp.unlink(fp).catch(() => {});
        stats.obfuscated++;
        stats.files.push({ path: outPath.replace(dir + path.sep, ''), status: 'success' });
        log('ok', `Encrypted: ${outPath.replace(dir + path.sep, '')}`);
      } catch (err) {
        // Last resort: obfuscate raw source as-is (works for .js, partial for .ts)
        try {
          const raw = await fsp.readFile(fp, 'utf8');
          const outPath = isTS ? fp.replace(/\.ts$/, '.js') : fp;
          await fsp.writeFile(outPath, banner + obfuscate(raw), 'utf8');
          if (isTS && outPath !== fp) await fsp.unlink(fp).catch(() => {});
          stats.obfuscated++;
          stats.files.push({ path: outPath.replace(dir + path.sep, ''), status: 'success' });
          log('ok', `Encrypted (raw): ${outPath.replace(dir + path.sep, '')}`);
        } catch (err2) {
          stats.failed++;
          stats.files.push({ path: rel, status: 'failed', error: err2.message });
          log('fail', `Failed: ${rel} — ${err2.message}`);
        }
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
