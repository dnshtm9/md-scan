// Entrypoint for the markdown rendering contest.
//
// Reads every case from <input>/cases.json, renders it with parse() from
// ./parse.js, and writes the resulting HTML strings, in order, to
// <output>/html.json. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR replace the
// container's /input and /output when running locally.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const rendered: string[] = [];
for (let i = 0; i < cases.length; i++) {
  rendered.push(parse(cases[i].markdown));
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));