import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { name: string; version: string };

export const PACKAGE_NAME = manifest.name;
export const PACKAGE_VERSION = manifest.version;
