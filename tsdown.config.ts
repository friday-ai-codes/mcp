import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  fixedExtension: false,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
})
