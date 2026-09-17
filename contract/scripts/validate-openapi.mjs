import { readFile } from 'node:fs/promises';

const contract = await readFile(new URL('../openapi/consenthub-api.yaml', import.meta.url), 'utf8');

if (!contract.startsWith('openapi:')) {
  throw new Error('The OpenAPI contract must declare an openapi version.');
}

for (const requiredSection of ['info:', 'paths:', 'components:']) {
  if (!contract.includes(requiredSection)) {
    throw new Error(`The OpenAPI contract is missing ${requiredSection}`);
  }
}

console.log('OpenAPI contract is present and structurally valid.');
