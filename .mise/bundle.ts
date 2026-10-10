import solidTransformPlugin from '@opentui/solid/bun-plugin';

const usage = 'Usage: bun .mise/bundle.ts <package-dir> <outdir> [--sourcemap]';
const [pkg, outdir, ...flags] = Bun.argv.slice(2);
if (!pkg || !outdir) throw new Error(usage);

for (const file of ['index.ts', 'tui.ts', 'tui.tsx']) {
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
