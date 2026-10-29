#!/usr/bin/env node
/**
 * Rewrite the checked-out package into a GitHub Packages–compatible copy.
 *
 * GitHub Packages' npm registry only accepts scoped packages whose scope
 * matches the repository owner, so the published name becomes
 * `@<owner>/dsh-adapter-qq` and the bundle patch is updated to resolve the same
 * specifier. The runtime plugin name ("adapter-qq") and settings namespace are
 * unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';

const owner = String(process.env.GITHUB_REPOSITORY_OWNER || '').trim().toLowerCase();
if (!owner) {
  console.error('GITHUB_REPOSITORY_OWNER is required');
  process.exit(1);
}

const scopedName = `@${owner}/dsh-adapter-qq`;
const pkgPath = path.resolve('package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.name = scopedName;
pkg.publishConfig = {
  registry: 'https://npm.pkg.github.com',
};
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const patchPath = path.resolve('cordis.patch.yml');
if (fs.existsSync(patchPath)) {
  const source = fs.readFileSync(patchPath, 'utf8');
  fs.writeFileSync(
    patchPath,
    source.replace(/(\bname:\s*)dsh-adapter-qq\b/g, `$1"${scopedName}"`)
  );
}

console.log(`Prepared GitHub Packages copy: ${scopedName}@${pkg.version}`);
