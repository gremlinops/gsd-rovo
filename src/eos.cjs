'use strict';

/**
 * Rovo CLI host-integration axes and the handshake against the installed gsd-core.
 *
 * Each value is backed by evidence in FINDINGS.md (Rovo CLI 202609.30.1), or is
 * the `undocumented` sentinel so the engine degrades it fail-closed.
 */

const path = require('node:path');

const UNDOCUMENTED = 'undocumented';
const SUPPORTED_PROTOCOL_VERSION = 1;

const ROVO_AXES = Object.freeze({
  embeddingMode: 'declarative',
  // No custom slash commands; `/prompts <name>` passes no arguments. Commands ship as skills.
  commandSurface: 'prose-only',
  dispatch: Object.freeze({
    // invoke_subagents dispatches a named subagent from the main agent. Depth 1 is a verified
    // lower bound; nesting is untested, so this stays at 1 until proven.
    namedDispatch: true,
    nested: UNDOCUMENTED,
    maxDepth: 1,
    background: UNDOCUMENTED,
    subagentToolkit: UNDOCUMENTED,
    backgroundDispatch: UNDOCUMENTED,
    isolation: 'none',
    maxConcurrency: UNDOCUMENTED,
  }),
  modelMode: 'passive',
  // eventHooks fire on tool start and end. In Rovo CLI 202609.30.1 they cannot block a tool call.
  hookBus: 'host',
  stateIO: 'filesystem',
  transport: 'mcp',
  runtime: 'python',
  effortSurface: UNDOCUMENTED,
});

function resolveCoreRoot() {
  return path.dirname(require.resolve('@opengsd/gsd-core/package.json'));
}

// gsd-core has no `exports` map; this internal path is the SDK entry every EoS uses.
// It is only safe because the dependency is pinned exactly: re-check it on every bump.
function loadSdk(coreRoot = resolveCoreRoot()) {
  return require(path.join(coreRoot, 'gsd-core', 'bin', 'lib', 'host-integration-sdk.cjs'));
}

function negotiate({ SDK, coreRoot, coreVersion }) {
  const request = SDK.buildHandshakeRequest({ protocolVersion: SUPPORTED_PROTOCOL_VERSION, axes: ROVO_AXES });
  const negotiation = SDK.handleHandshakeRequest(request);
  if (negotiation.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
    throw new Error(`gsd-rovo: negotiated protocol v${JSON.stringify(negotiation.protocolVersion)}, need v${SUPPORTED_PROTOCOL_VERSION}`);
  }
  const profile = SDK.profileOf(negotiation.effective);
  if (profile !== 'declarative-cli') {
    throw new Error(`gsd-rovo: expected declarative-cli profile, got ${JSON.stringify(profile)}`);
  }
  return Object.freeze({ SDK, coreRoot, coreVersion, axes: ROVO_AXES, request, negotiation, profile });
}

let cached;

function initialize() {
  if (!cached) {
    const coreRoot = resolveCoreRoot();
    const coreVersion = require(path.join(coreRoot, 'package.json')).version;
    cached = negotiate({ SDK: loadSdk(coreRoot), coreRoot, coreVersion });
  }
  return cached;
}

function descriptorOf(ctx) {
  return {
    id: 'gsd-rovo',
    protocolVersion: ctx.negotiation.protocolVersion,
    profile: ctx.profile,
    interfacePoints: ctx.SDK.INTERFACE_POINTS.filter((p) => ctx.negotiation.points[p]?.effectiveLevel !== 'absent'),
    axes: ctx.axes,
  };
}

module.exports = Object.freeze({
  ROVO_AXES,
  UNDOCUMENTED,
  SUPPORTED_PROTOCOL_VERSION,
  resolveCoreRoot,
  loadSdk,
  negotiate,
  initialize,
  descriptorOf,
});
