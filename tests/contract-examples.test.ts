import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { ContractRun, isCliStep, loadScenario, PACKAGE_ROOT, relativeToPackage, scenarioFiles, subsetMismatch } from './contract.js';

// docs/integration.md가 링크하는 정본 예제다. 새 예제를 더하면 문서에도 링크한다
const EXPECTED = ['code-profile.json', 'hash-normalization.json', 'master-profile.json', 'negotiation.json', 'outcomes.json', 'reference-checks.json', 'retention.json'];

test('contract examples are all present and linked from docs/integration.md', () => {
  const files = scenarioFiles().map((path) => basename(path));
  assert.deepEqual(files, EXPECTED);
  const integration = readFileSync(join(PACKAGE_ROOT, 'docs', 'integration.md'), 'utf8');
  for (const name of [...files, 'handoff-cases.json']) assert.ok(integration.includes(`contract/${name}`), `docs/integration.md does not link contract/${name}`);
});

for (const file of scenarioFiles()) {
  test(`contract example ${relativeToPackage(file)} matches the real CLI`, () => {
    const scenario = loadScenario(file);
    const ids = scenario.steps.map((step) => step.id);
    assert.equal(new Set(ids).size, ids.length, 'step ids must be unique');
    const run = new ContractRun(scenario.fixture);
    try {
      for (const step of scenario.steps) {
        const result = run.run(step);
        if (!isCliStep(step)) continue;
        assert.ok(result);
        assert.equal(result.exitCode, step.exitCode, `${step.id}: exit code ${result.exitCode}, stdout ${JSON.stringify(result.stdout)}`);
        const mismatch = subsetMismatch(step.stdout, result.stdout);
        assert.equal(mismatch, undefined, `${step.id}: ${mismatch}`);
      }
    } finally {
      run.dispose();
    }
  });
}
