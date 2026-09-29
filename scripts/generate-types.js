import fs from 'node:fs/promises';
import path from 'node:path';
import { compileFromFile } from 'json-schema-to-typescript';

const SCHEMA_DIR = path.resolve('src/schemas');
const GENERATED_DIR = path.resolve('src/generated');

async function run() {
  await fs.mkdir(GENERATED_DIR, { recursive: true });

  const schemas = [
    { file: 'snapshot.schema.json', out: 'snapshot.ts' },
    { file: 'plan.schema.json', out: 'plan.ts' },
    { file: 'review.schema.json', out: 'review.ts' }
  ];

  for (const { file, out } of schemas) {
    const filePath = path.join(SCHEMA_DIR, file);
    const ts = await compileFromFile(filePath, {
      cwd: SCHEMA_DIR,
      bannerComment: '/* eslint-disable */\n/**\n * This file was automatically generated from JSON Schema.\n * DO NOT MODIFY IT BY HAND. Instead, modify the source schema and re-run typegen.\n */\n'
    });
    await fs.writeFile(path.join(GENERATED_DIR, out), ts, 'utf8');
    console.log(`Generated ${out} from ${file}`);
  }

  const indexContent = `/* eslint-disable */
export * from './snapshot.js';
export * from './plan.js';
export type { Review } from './review.js';
`;
  await fs.writeFile(path.join(GENERATED_DIR, 'index.ts'), indexContent, 'utf8');
  console.log('Generated index.ts');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
