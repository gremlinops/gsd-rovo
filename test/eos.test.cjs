'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const eos = require('../src/eos.cjs');

const isUndocumented = (v) => v === eos.UNDOCUMENTED;

test('every scalar axis value is in the SDK vocabulary or undocumented', () => {
  const vocab = eos.loadSdk().HOST_INTEGRATION_AXES;
  for (const [axis, value] of Object.entries(eos.ROVO_AXES)) {
    if (axis === 'dispatch') continue;
    assert.ok(vocab[axis], `SDK has no axis ${axis}`);
    assert.ok(isUndocumented(value) || vocab[axis].includes(value), `${axis}=${value}`);
  }
});

test('every dispatch field has the right type or is undocumented', () => {
  const vocab = eos.loadSdk().HOST_INTEGRATION_AXES;
  const d = eos.ROVO_AXES.dispatch;
  for (const key of ['namedDispatch', 'nested', 'background', 'backgroundDispatch']) {
    assert.ok(isUndocumented(d[key]) || typeof d[key] === 'boolean', `dispatch.${key}=${d[key]}`);
  }
  for (const key of ['maxDepth', 'maxConcurrency']) {
    assert.ok(isUndocumented(d[key]) || Number.isInteger(d[key]), `dispatch.${key}=${d[key]}`);
  }
  assert.ok(isUndocumented(d.subagentToolkit) || vocab.subagentToolkit.includes(d.subagentToolkit));
  assert.ok(isUndocumented(d.isolation) || vocab.isolation.includes(d.isolation));
});

test('negotiation warns only about undocumented values', () => {
  const { warnings } = eos.initialize().negotiation;
  assert.deepEqual(warnings.filter((w) => !/undocumented/.test(w)), []);
});

test('handshake negotiates a declarative-cli profile at protocol v1', () => {
  const ctx = eos.initialize();
  assert.equal(ctx.profile, 'declarative-cli');
  assert.equal(ctx.negotiation.protocolVersion, 1);
  assert.equal(ctx.negotiation.effective.hookBus, 'host');
  assert.equal(ctx.negotiation.effective.commandSurface, 'prose-only');
  assert.equal(ctx.negotiation.effective.dispatch.namedDispatch, true);
  assert.equal(ctx.negotiation.points.hooks.effectiveLevel, 'full');
  assert.equal(ctx.negotiation.points.state.effectiveLevel, 'full');
  assert.match(ctx.coreVersion, /^\d+\.\d+\.\d+/);
});

test('dispatch negotiates to flat (one level), not absent', () => {
  const { effective, points } = eos.initialize().negotiation;
  assert.equal(effective.dispatch.maxDepth, 1);
  assert.equal(effective.dispatch.nested, false);
  assert.equal(points.dispatch.effectiveLevel, 'degraded');
  assert.match(points.dispatch.fallback, /flat dispatch/);
});

test('undocumented dispatch fields degrade closed', () => {
  const { dispatch } = eos.initialize().negotiation.effective;
  assert.equal(dispatch.subagentToolkit, 'read-only');
  assert.equal(dispatch.maxConcurrency, 1);
  assert.equal(dispatch.isolation, 'none');
});

test('serialized and in-process negotiation agree', () => {
  const ctx = eos.initialize();
  const inProcess = ctx.SDK.negotiateHostCapabilities({ ...eos.ROVO_AXES, protocolVersion: eos.SUPPORTED_PROTOCOL_VERSION });
  assert.deepEqual(JSON.parse(JSON.stringify(inProcess)), ctx.negotiation);
});

test('descriptor lists only interface points that are not absent', () => {
  const desc = eos.descriptorOf(eos.initialize());
  assert.equal(desc.id, 'gsd-rovo');
  assert.equal(desc.protocolVersion, 1);
  assert.equal(desc.profile, 'declarative-cli');
  assert.deepEqual(desc.interfacePoints, ['dispatch', 'model', 'hooks', 'state', 'artifact']);
  assert.deepEqual(desc.axes, eos.ROVO_AXES);
});

function fakeSdk({ protocolVersion = 1, profile = 'declarative-cli' } = {}) {
  return {
    INTERFACE_POINTS: [],
    buildHandshakeRequest: (d) => d,
    handleHandshakeRequest: () => ({ protocolVersion, effective: {}, points: {}, warnings: [] }),
    profileOf: () => profile,
  };
}

test('negotiate rejects a protocol version other than v1', () => {
  for (const v of [0, 2]) {
    assert.throws(() => eos.negotiate({ SDK: fakeSdk({ protocolVersion: v }) }), new RegExp(`protocol v${v}, need v1`));
  }
});

test('negotiate rejects a profile other than declarative-cli', () => {
  assert.throws(() => eos.negotiate({ SDK: fakeSdk({ profile: 'ide' }) }), /expected declarative-cli profile, got "ide"/);
});

test('negotiate sends the supported protocol version and the Rovo axes', () => {
  const ctx = eos.negotiate({ SDK: fakeSdk(), coreRoot: '/x', coreVersion: '9.9.9' });
  assert.deepEqual(ctx.request, { protocolVersion: 1, axes: eos.ROVO_AXES });
  assert.equal(ctx.coreVersion, '9.9.9');
});
