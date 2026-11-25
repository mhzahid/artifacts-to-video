// electron-builder afterPack hook (runs before signing and before the installer is compressed):
//  1. trims files the app never uses, to shrink the installer;
//  2. refuses to produce an installer that can't make videos (no FFmpeg / no headless Chromium).
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const app = context.appOutDir;
  const res = path.join(app, 'resources');
  const win = context.electronPlatformName === 'win32';

  // --- 1. trim -------------------------------------------------------------------------------
  let freed = 0;
  const drop = (p) => { try { const s = fs.statSync(p); fs.rmSync(p, { recursive: true, force: true }); freed += s.isFile() ? s.size : 0; } catch {} };
  // DirectX shader compiler: only used by WebGPU, which the app's window never uses (~26 MB).
  if (win && process.env.A2V_KEEP_DXC !== '1') { drop(path.join(app, 'dxcompiler.dll')); drop(path.join(app, 'dxil.dll')); }
  if (freed) console.log(`  • trimmed ${(freed / 1e6).toFixed(1)} MB of unused Electron files`);

  // --- 2. completeness check -----------------------------------------------------------------
  const exe = win ? 'ffmpeg.exe' : 'ffmpeg';
  const ffmpeg = path.join(res, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', exe);
  const browsers = path.join(res, 'browsers');
  const problems = [];
  if (!fs.existsSync(ffmpeg)) problems.push(`FFmpeg binary missing: ${ffmpeg}\n  Fix: run "npm run ensure" (downloads ffmpeg-static's binary), then build again.`);
  const shell = fs.existsSync(browsers) && fs.readdirSync(browsers).some((d) => d.startsWith('chromium_headless_shell-'));
  if (!shell) problems.push(`Headless Chromium missing in ${browsers}\n  Fix: run "npm run browsers", then build again.`);
  if (problems.length) throw new Error(`Packaged app is incomplete:\n- ${problems.join('\n- ')}`);
  console.log('  • afterPack check passed (FFmpeg + headless Chromium bundled)');
};
