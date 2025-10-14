const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function formatDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}-${m}-${d} ${h}:${mi}:${s}`;
}

function listDirs(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeText(file, content) {
  fs.writeFileSync(file, content, 'utf8');
}

function isRuleLine(line) {
  if (!line) return false;
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('#')) return false;
  return true;
}

function parseCountsFromList(content) {
  const lines = content.split(/\r?\n/);
  const typeCounts = Object.create(null);
  let total = 0;
  for (const line of lines) {
    if (!isRuleLine(line)) continue;
    const idx = line.indexOf(',');
    const type = (idx === -1 ? line : line.slice(0, idx)).trim();
    if (!type) continue;
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    total += 1;
  }
  return { typeCounts, total };
}

function updateListHeader(content, { updatedAt, domainCount, domainSuffixCount, total }) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let hasUpdated = false;
  let hasDomain = false;
  let hasDomainSuffix = false;
  let hasTotal = false;

  for (const line of lines) {
    if (line.startsWith('# UPDATED:')) {
      out.push(`# UPDATED: ${updatedAt}`);
      hasUpdated = true;
    } else if (line.startsWith('# DOMAIN:')) {
      out.push(`# DOMAIN: ${domainCount}`);
      hasDomain = true;
    } else if (line.startsWith('# DOMAIN-SUFFIX:')) {
      out.push(`# DOMAIN-SUFFIX: ${domainSuffixCount}`);
      hasDomainSuffix = true;
    } else if (line.startsWith('# TOTAL:')) {
      out.push(`# TOTAL: ${total}`);
      hasTotal = true;
    } else {
      out.push(line);
    }
  }

  // If headers do not exist, add them near the top (after any shebang or first line)
  let headerInserted = false;
  function insertHeaderIfMissing(tag, line) {
    if (headerInserted) return;
    // find first non-empty position to insert
    const idx = out.findIndex((l) => l.trim().length > 0);
    const insertAt = idx === -1 ? 0 : Math.min(idx + 1, out.length);
    out.splice(insertAt, 0, line);
    headerInserted = true;
  }

  if (!hasUpdated) insertHeaderIfMissing('UPDATED', `# UPDATED: ${updatedAt}`);
  if (!hasDomain) out.splice(2, 0, `# DOMAIN: ${domainCount}`);
  if (!hasDomainSuffix) out.splice(3, 0, `# DOMAIN-SUFFIX: ${domainSuffixCount}`);
  if (!hasTotal) out.splice(4, 0, `# TOTAL: ${total}`);

  return out.join('\n');
}

function updateReadme(content, { updatedAt, domainCount, domainSuffixCount, total, tempName }) {
  const lines = content.split(/\r?\n/);

  const updatedAtPrefix = '最后更新时间：';
  const tableMatchers = [
    { key: 'DOMAIN', value: domainCount },
    { key: 'DOMAIN-SUFFIX', value: domainSuffixCount },
    { key: 'TOTAL', value: total },
  ];

  const newLines = lines.map((line) => {
    if (line.startsWith(updatedAtPrefix)) {
      return `${updatedAtPrefix}${updatedAt}`;
    }
    for (const { key, value } of tableMatchers) {
      const regex = new RegExp(`^\\|\\s*${key.replace('-', '\\-')}\\s*\\|\\s*\\d+\\s*\\|$`);
      if (regex.test(line)) {
        return `| ${key.padEnd(14, ' ')} | ${String(value).padEnd(5, ' ')} |`;
      }
    }
    // If template placeholders exist, replace them too
    if (line.includes('${{ datetime }}')) {
      return line.replace('${{ datetime }}', updatedAt);
    }
    if (line.includes('${{ TempName }}') && tempName) {
      return line.replaceAll('${{ TempName }}', tempName);
    }
    return line;
  });

  return newLines.join('\n');
}

function processRuleDir(ruleDir) {
  // search for a single .list and README.md directly under ruleDir
  const entries = fs.readdirSync(ruleDir, { withFileTypes: true });
  const listFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.list')).map((e) => e.name);
  if (listFiles.length === 0) return { changed: false };

  const listFile = path.join(ruleDir, listFiles[0]);
  const readmeFile = path.join(ruleDir, 'README.md');

  const listContent = readText(listFile);
  const { typeCounts, total } = parseCountsFromList(listContent);
  const domainCount = typeCounts['DOMAIN'] || 0;
  const domainSuffixCount = typeCounts['DOMAIN-SUFFIX'] || 0;
  const updatedAt = formatDate();

  const updatedList = updateListHeader(listContent, {
    updatedAt,
    domainCount,
    domainSuffixCount,
    total,
  });
  writeText(listFile, updatedList);

  if (fs.existsSync(readmeFile)) {
    const readmeContent = readText(readmeFile);
    const tempName = path.basename(listFile, '.list');
    const updatedReadme = updateReadme(readmeContent, {
      updatedAt,
      domainCount,
      domainSuffixCount,
      total,
      tempName,
    });
    writeText(readmeFile, updatedReadme);
  }

  return { changed: true, listFile, readmeFile };
}

function getChangedRuleDirs(repoRoot, ruleRoot) {
  // Use git porcelain to capture staged and unstaged changes
  let output = '';
  try {
    output = cp.execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf8' });
  } catch (e) {
    return new Set();
  }

  const changed = new Set();
  const changedPaths = [];
  const lines = output.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    // Line formats include: " M path", "A  path", "R  old -> new"
    // We only care about the final path token
    const renameIdx = line.indexOf('->');
    const rawPath = renameIdx !== -1
      ? line.slice(renameIdx + 2).trim()
      : line.slice(3).trim(); // skip status columns
    if (!rawPath) continue;

    // Normalize to POSIX-style and ensure under rule/
    const posixPath = rawPath.replace(/\\/g, '/');
    if (!posixPath.startsWith('rule/')) continue;
    changedPaths.push(posixPath);

    // Expect structure: rule/<platform>/<ruleSet>/...
    const parts = posixPath.split('/');
    if (parts.length < 3) continue;
    const platform = parts[1];
    const ruleSet = parts[2];
    if (!platform || !ruleSet) continue;
    if (platform === '__template__') continue;

    const absDir = path.join(ruleRoot, platform, ruleSet);
    if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
      changed.add(absDir);
    }
  }

  if (changedPaths.length > 0) {
    console.log('Changed files under rule/:');
    for (const p of changedPaths) {
      console.log(' -', p);
    }
  }

  return changed;
}

function main() {
  const ruleRoot = path.resolve(__dirname);
  const repoRoot = path.resolve(ruleRoot, '..');
  const ignored = new Set(['__template__', '.git']);

  // Compute changed rule directories from git status
  const changedDirs = getChangedRuleDirs(repoRoot, ruleRoot);

  let changedAny = false;

  if (changedDirs.size === 0) {
    console.log('No changed files under rule/ detected by git status.');
    return;
  }

  console.log('Rule directories to update:');
  for (const dir of changedDirs) {
    console.log(' -', path.relative(repoRoot, dir));
  }

  for (const dir of changedDirs) {
    const basename = path.basename(dir);
    if (ignored.has(basename)) continue;
    const result = processRuleDir(dir);
    if (result.changed) changedAny = true;
  }

  if (!changedAny) {
    console.log('No rule sets updated.');
  } else {
    console.log('Rule sets updated successfully.');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Failed to update rule stats:', err);
    process.exitCode = 1;
  }
}


