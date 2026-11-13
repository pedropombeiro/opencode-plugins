import solidTransformPlugin from '@opentui/solid/bun-plugin';

const usage = 'Usage: bun .mise/bundle.ts <package-dir> <outdir> [--sourcemap]';
const [pkg, outdir, ...flags] = Bun.argv.slice(2);
if (!pkg || !outdir) throw new Error(usage);

for (const file of ['index.ts', 'tui.ts', 'tui.tsx', 'worker.ts']) {
  const entry = `${pkg}/src/${file}`;
  if (!(await Bun.file(entry).exists())) continue;
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: 'bun',
    sourcemap: flags.includes('--sourcemap') ? 'inline' : 'none',
    external: ['@opencode/plugin', '@opencode/plugin/*', 'solid-js', 'solid-js/*', '@opentui/*'],
    plugins: [solidTransformPlugin],
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    process.exit(1);
  }
}

// The desktop app loads `gui-experimental.cjs`, one CommonJS file that its
// Vite preset builds with Solid's DOM transform.
const gui = `${pkg}/src/gui.tsx`;
if (await Bun.file(gui).exists()) {
  const { resolve } = await import('node:path');
  const build = Bun.spawnSync(
    ['node', 'node_modules/vite/bin/vite.js', 'build', '--config', '.mise/vite.gui.config.mjs'],
    {
      env: {
        ...process.env,
        GUI_ENTRY: resolve(gui),
        GUI_OUT: resolve(outdir, 'gui-experimental.cjs'),
        ...(flags.includes('--sourcemap') ? { GUI_SOURCEMAP: '1' } : {}),
      },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
}
