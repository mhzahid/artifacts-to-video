// `npm run dist` / `npm run dist:dir`: sync engine → ensure binaries → fetch Chromium → electron-builder.
//
// On Windows, files of a previous build can stay locked (a running "Artifact to Video.exe" from
// win-unpacked, its headless_shell.exe, or another Electron app such as VS Code or the Claude desktop
// app that opened app.asar). electron-builder then fails with EBUSY when it replaces win-unpacked.
// So every local build goes into its own fresh folder, dist/build-<time>/, which nothing can have
// open yet. The installer is then copied to dist/, and older build folders are cleaned up when
// they're no longer locked. (CI machines start clean, so CI keeps the plain dist/ layout.)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv.includes('--dir') ? 'dir' : 'nsis';
const node = (script, args = []) => execFileSync(process.execPath, [path.join(here, script), ...args], { cwd: here, stdio: 'inherit' });
const dist = path.join(here, 'dist');
const tryRemove = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }); return !fs.existsSync(p); } catch { return false; } };

node('scripts/sync-engine.mjs');
node('scripts/ensure-binaries.mjs');
node('scripts/fetch-chromium.mjs');

// ---- code signing: picked from environment variables (nothing secret lives in the repo) ----------
//  Azure Artifact Signing:  AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, AZURE_SIGN_PUBLISHER
//                           + AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (service principal)
//  Certificate in the Windows certificate store / USB token / cloud-HSM virtual card:
//                           WIN_CERT_SHA1 (thumbprint), optional WIN_CERT_PUBLISHER
//  PFX file (self-signed test cert, or an older exportable cert):  CSC_LINK + CSC_KEY_PASSWORD
//  A2V_REQUIRE_SIGNING=1 makes the build fail instead of producing an unsigned installer.
const env = process.env;
const signArgs = [];
let signing = 'none (unsigned: Windows SmartScreen will warn users)';
if (env.AZURE_SIGN_ENDPOINT) {
  for (const k of ['AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) {
    if (!env[k]) { console.error(`✗ Azure signing: ${k} is not set.`); process.exit(1); }
  }
  signArgs.push(`--config.win.azureSignOptions.endpoint=${env.AZURE_SIGN_ENDPOINT}`,
    `--config.win.azureSignOptions.codeSigningAccountName=${env.AZURE_SIGN_ACCOUNT}`,
    `--config.win.azureSignOptions.certificateProfileName=${env.AZURE_SIGN_PROFILE}`,
    `--config.win.azureSignOptions.publisherName=${env.AZURE_SIGN_PUBLISHER}`);
  signing = `Azure Artifact Signing (${env.AZURE_SIGN_ACCOUNT}/${env.AZURE_SIGN_PROFILE})`;
} else if (env.WIN_CERT_SHA1) {
  signArgs.push(`--config.win.signtoolOptions.certificateSha1=${env.WIN_CERT_SHA1.replace(/\s/g, '')}`,
    '--config.win.signtoolOptions.rfc3161TimeStampServer=http://timestamp.digicert.com');
  if (env.WIN_CERT_PUBLISHER) signArgs.push(`--config.win.signtoolOptions.publisherName=${env.WIN_CERT_PUBLISHER}`);
  signing = `certificate ${env.WIN_CERT_SHA1.slice(0, 8)}… from the Windows certificate store`;
} else if (env.CSC_LINK || env.WIN_CSC_LINK) {
  signing = 'PFX file from CSC_LINK';
}
if (env.A2V_REQUIRE_SIGNING === '1') {
  if (signing.startsWith('none')) { console.error('✗ A2V_REQUIRE_SIGNING=1 but no signing method is configured.'); process.exit(1); }
  signArgs.push('--config.win.forceCodeSigning=true');
}
console.log(`> code signing: ${signing}`);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const outRel = process.env.CI ? 'dist' : path.join('dist', `build-${stamp}`);
const out = path.join(here, outRel);

const cli = path.join(here, 'node_modules', 'electron-builder', 'cli.js');
execFileSync(process.execPath, [cli, '--win', target, '--x64', '--publish', 'never', `--config.directories.output=${outRel}`, ...signArgs],
  { cwd: here, stdio: 'inherit' });

if (!process.env.CI) {
  // Copy the installer to dist/ so it's always in the same place.
  let installer = null;
  for (const f of fs.readdirSync(out)) {
    if (!f.endsWith('.exe')) continue;
    let dest = path.join(dist, f);
    try { fs.copyFileSync(path.join(out, f), dest); }
    catch { dest = path.join(dist, f.replace(/\.exe$/, `-${stamp}.exe`)); fs.copyFileSync(path.join(out, f), dest); } // old installer still open
    installer = dest;
  }
  // Best-effort cleanup of earlier builds; anything still locked is left for next time.
  const leftovers = [];
  for (const f of fs.readdirSync(dist)) {
    const p = path.join(dist, f);
    const old = (f.startsWith('build-') && p !== out) || f === 'win-unpacked' || f === 'win-unpacked.tmp' || f.startsWith('builder-');
    if (old && !tryRemove(p)) leftovers.push(f);
  }
  console.log('');
  if (installer) console.log(`✓ Installer: ${installer}`);
  console.log(`✓ Unpacked app: ${path.join(out, 'win-unpacked')}`);
  if (process.platform === 'win32') verifySignatures([installer, path.join(out, 'win-unpacked', 'Artifact to Video.exe')].filter(Boolean));
  if (leftovers.length) console.log(`  (couldn't remove ${leftovers.join(', ')} yet, still in use; they'll be cleaned up on a later build)`);
}

// Show the Authenticode status of the built files (Windows only).
function verifySignatures(files) {
  for (const f of files) {
    try {
      const ps = `$s = Get-AuthenticodeSignature -LiteralPath '${f.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
      const [status, subject] = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim().split('|');
      const mark = status === 'Valid' ? '✓' : status === 'NotSigned' ? '·' : '!';
      console.log(`  ${mark} signature ${status}${subject ? ` (${subject})` : ''}: ${path.basename(f)}`);
    } catch { /* PowerShell unavailable */ }
  }
}
