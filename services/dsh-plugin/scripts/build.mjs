import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = await build({
  absWorkingDir: root,
  entryPoints: ['src/client.jsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text', '.png': 'dataurl' },
  legalComments: 'inline',
});
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/client.js', import.meta.url),
  `window.__ModuleLoader__.load({id:"dsh-browser-qz",factory(require){
var module={exports:{}},exports=module.exports;
${output.outputFiles[0].text}
return module.exports;
}});\n`);
