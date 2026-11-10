#!/usr/bin/env node
// Generate the D9 source-OTA attestation for a release checkout.
//
// Run by .github/workflows/release.yml after SHA256SUMS exists and before the
// attestation is signed with cosign. The output is deterministic: fixed field
// order and sorted asset names, so re-running on the same bytes produces the
// same file and therefore the same signature payload.
//
// Usage:
//   node scripts/generate-release-attestation.mjs \
//     --tag v1.2.3 --commit <40-hex> --tree <40-hex> \
//     [--root .] [--out release-attestation.json] [--repository dwgx/WindsurfAPI] \
//     [--asset name=path ...]

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ATTESTATION_REPOSITORY,
  DEFAULT_RELEASE_ASSETS,
  ReleaseAttestationError,
  buildReleaseAttestation,
  serializeReleaseAttestation,
} from '../src/release-attestation.js';

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv) {
  const options = {
    tag: '',
    commit: '',
    tree: '',
    root: '.',
    out: '',
    repository: DEFAULT_ATTESTATION_REPOSITORY,
    assets: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (!['--tag', '--commit', '--tree', '--root', '--out', '--repository', '--asset'].includes(arg)) {
      throw new CliError(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value === '') throw new CliError(`${arg} needs a value`);
    index += 1;
    if (arg === '--tag') options.tag = value;
    if (arg === '--commit') options.commit = value;
    if (arg === '--tree') options.tree = value;
    if (arg === '--root') options.root = value;
    if (arg === '--out') options.out = value;
    if (arg === '--repository') options.repository = value;
    if (arg === '--asset') {
      const separator = value.indexOf('=');
      if (separator <= 0 || separator === value.length - 1) {
        throw new CliError(`--asset must be name=path, got ${value}`);
      }
      options.assets[value.slice(0, separator)] = value.slice(separator + 1);
    }
  }
  if (!options.tag) throw new CliError('--tag is required');
  if (!options.commit) throw new CliError('--commit is required');
  if (!options.tree) throw new CliError('--tree is required');
  return options;
}

export function usage() {
  return `Generate the WindsurfAPI release attestation.

Usage:
  node scripts/generate-release-attestation.mjs --tag <vX.Y.Z> --commit <sha> --tree <sha>
                                                [options]

Options:
  --tag <vX.Y.Z>          release tag (required)
  --commit <sha>          commit the tag peels to (required)
  --tree <sha>            git tree of that commit (required)
  --root <dir>            checkout root (default: .)
  --out <file>            output file (default: stdout)
  --repository <owner/name>  repository recorded in the attestation
  --asset <name=path>     release-asset name -> path relative to --root
                          (repeatable; default: the release job layout)
  -h, --help              show this help`;
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const assets = Object.keys(options.assets).length ? options.assets : DEFAULT_RELEASE_ASSETS;
  const attestation = await buildReleaseAttestation({
    tag: options.tag,
    commit: options.commit,
    tree: options.tree,
    root: resolve(options.root),
    assets,
    repository: options.repository,
  });
  const text = serializeReleaseAttestation(attestation);
  if (options.out) {
    writeFileSync(resolve(options.out), text, 'utf8');
    console.log(`wrote ${resolve(options.out)}`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`error: ${err.message}`);
      process.exitCode = err instanceof CliError || err instanceof ReleaseAttestationError ? err.exitCode || 1 : 1;
    });
}
