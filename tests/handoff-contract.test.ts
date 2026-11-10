import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { refHandle } from '../src/retrieval/compose-v2.js';
import { sha256 } from '../src/util/hash.js';
import { ContractRun, CONTRACT_DIR, isCliStep, loadScenario } from './contract.js';
import { checkOf, decideSend, gateOf, handoffDigest, loadHandoffCases, parseHandoff, submitScope, type Candidate, type Ref } from './handoff.js';

/**
 * docs/contract/handoff-cases.json의 인계 사례를 참조 구현과 실제 CLI로 확인한다.
 * 이 시험이 통과해도 소비자 연동이 끝났다는 뜻은 아니다. 소비자는 같은 사례 파일을 자기 파서와 송신 코드로 돌려야 한다.
 */

const cases = loadHandoffCases();

describe('handoff contract cases', () => {
  let run: ContractRun;
  before(() => {
    run = new ContractRun(cases.fixture);
  });
  after(() => run.dispose());

  test('case ids are unique', () => {
    const ids = [...cases.cases.map((entry) => entry.id), ...cases.hello.map((entry) => entry.id)];
    assert.equal(new Set(ids).size, ids.length);
  });

  test('receiver scope matches the verify scope', () => {
    assert.deepEqual(cases.receiver.scope.projects, [cases.receiver.project]);
  });

  for (const entry of cases.cases) {
    test(`receiver parses ${entry.id}`, () => {
      const knowledge = run.substitute(entry.knowledge);
      const parsed = parseHandoff(knowledge, entry.receiverVersions);
      if (!entry.expect.accepted) {
        assert.deepEqual(parsed, entry.expect);
        assert.equal(entry.submit, undefined, 'a case rejected by the parser never reaches the scope check');
        return;
      }
      assert.equal(parsed.accepted, true, JSON.stringify(parsed));
      if (!parsed.accepted) return;
      assert.deepEqual(parsed.refs, run.substitute(entry.expect.refs));
      if (entry.expect.digest) assert.equal(handoffDigest(parsed.version, parsed.refs), entry.expect.digest);
      // 참조 순서를 바꿔도 같은 인계다
      assert.equal(handoffDigest(parsed.version, [...parsed.refs].reverse()), handoffDigest(parsed.version, parsed.refs));
      // 꼴이 맞아도 받는 쪽 등록 문서·대응 범위 밖 참조가 하나라도 있으면 인계 전체를 거절한다
      assert.deepEqual(submitScope(parsed.refs, cases.receiver), entry.submit ?? { accepted: true });
    });
  }

  for (const entry of cases.cases.filter((item) => item.verification)) {
    test(`receiver verifies ${entry.id} through the producer CLI in its own scope`, () => {
      const knowledge = run.substitute(entry.knowledge) as { refs: Ref[] };
      // 인계 참조를 그대로 넘긴다. verify는 required처럼 모르는 필드를 무시한다
      const result = run.run({ id: entry.id, argv: ['verify', '--request', '-'], request: { profile: cases.receiver.profile, scope: cases.receiver.scope, references: knowledge.refs }, exitCode: 0, stdout: null });
      assert.ok(result);
      assert.equal(result.exitCode, 0, JSON.stringify(result.stdout));
      const results = (result.stdout as { results: { reference: { verdict: string; mismatches: string[] } }[] }).results;
      const observed = knowledge.refs.map((ref, index) => {
        const reference = results[index]!.reference;
        return {
          itemId: ref.itemId,
          segmentId: ref.segmentId ?? null,
          required: ref.required ?? true,
          ...checkOf(reference.verdict, reference.mismatches),
          mismatches: reference.mismatches,
        };
      });
      assert.deepEqual(observed, entry.verification!.refs);
      const gate = gateOf(observed.map((ref) => ({ required: ref.required, check: ref })));
      assert.deepEqual(gate, entry.verification!.gate);
      assert.equal(entry.verification!.progress, gate.state === 'blocked' ? 'blocked' : 'allowed');
    });
  }
});

describe('handoff send decisions', () => {
  test('pool refs carry the producer handle of their own identity', () => {
    for (const [name, ref] of Object.entries(cases.refPool)) {
      const expected = refHandle({
        indexId: ref.indexId as string,
        indexGeneration: ref.indexGeneration as number,
        itemId: ref.itemId as string,
        segmentId: (ref.segmentId as string | null) ?? null,
        itemSha256: ref.itemSha256 as string,
        segmentSha256: (ref.segmentSha256 as string | null) ?? null,
      });
      assert.equal(ref.handle, expected, name);
    }
  });

  for (const entry of cases.hello) {
    test(`sender decides ${entry.id}`, () => {
      const candidates: Candidate[] = entry.refs.map((item) => {
        const ref = cases.refPool[item.use];
        assert.ok(ref, `unknown pool ref: ${item.use}`);
        return { ref, required: item.required, role: item.role };
      });
      const { payload, ...decision } = decideSend(entry.knowledge, entry.senderVersions, candidates);
      assert.deepEqual(decision, entry.expect);
      if (!payload) return;
      // 보낸 인계는 그 hello를 낸 수신자가 꼴·형식·범위 검사에서 받는다
      const announced = ((entry.knowledge as { refs: { versions?: number[] } }).refs.versions ?? [1]).filter((version) => typeof version === 'number');
      const parsed = parseHandoff(payload, announced);
      assert.equal(parsed.accepted, true, JSON.stringify(parsed));
      if (parsed.accepted) assert.deepEqual(submitScope(parsed.refs, cases.receiver), { accepted: true });
    });
  }
});

describe('content hash rule', () => {
  test('itemSha256 can be recomputed from raw bytes with the documented rule', () => {
    const scenario = loadScenario(`${CONTRACT_DIR}/hash-normalization.json`);
    const commit = scenario.steps.find((step) => 'commit' in step);
    assert.ok(commit && 'commit' in commit);
    let checked = 0;
    for (const step of scenario.steps.filter(isCliStep)) {
      const item = (step.stdout as { item?: { id: string; ref: { itemSha256: string; startLine: number; endLine: number } } }).item;
      if (!item) continue;
      const path = item.id.slice(item.id.indexOf(':') + 1, item.id.indexOf('#'));
      const raw: unknown = commit.commit.files[path];
      assert.equal(typeof raw, 'string');
      // docs/knowledge-model.md의 내용 해시: BOM을 지우고 \r\n, \n, \r을 줄 끝으로 보고, 줄 범위를 \n으로 잇는다
      const lines = (raw as string).replace(/^﻿/, '').split(/\r\n|\n|\r/);
      const content = lines.slice(item.ref.startLine - 1, item.ref.endLine).join('\n');
      assert.equal(sha256(content), item.ref.itemSha256, path);
      checked++;
    }
    assert.equal(checked, 6);
  });
});
