'use strict';

// Version adapter and write-safety policy.
//
// The bridge speaks to the QQ kernel through native method names that are not a
// stable API. The build ids below are the ones this repository has actually
// exercised on a real client. A different build is not automatically broken -
// it is simply not evidence, so the endpoint keeps reads open and makes writes
// opt-in (--allow-untested).
//
// Capabilities arrive in the bridge hello: `capabilities.missing` lists the
// service methods the bridge looked for and did not find. This module turns
// that raw snapshot into the two decisions the endpoint needs: is this build
// known, and is a write action allowed right now.

// Builds that have run against a real client in this repository. Keep the
// exact version string the launcher writes into app.config.json.
const TESTED_QQ_VERSIONS = Object.freeze([
  '9.9.36-53644',
  '9.9.36-53489'
]);

const BUILD_PROFILES = Object.freeze({
  '9.9.36-53644': {
    family: '9.9.36',
    notes: 'primary test client; group/file/notice actions measured here'
  },
  '9.9.36-53489': {
    family: '9.9.36',
    notes: 'second build; same kernel surface as 53644 where checked'
  }
});

// Actions with an effect other people can see, or that mutate a group/friend/
// file tree. Local red-dot clears, reads, window/tray tools and ping are not
// writes: they neither reach another account nor spend a server-side quota.
const WRITE_ACTIONS = new Set([
  'send_message',
  'upload_group_file',
  'recall',
  'set_group_ban',
  'set_group_whole_ban',
  'set_group_kick',
  'set_group_admin',
  'set_group_card',
  'set_group_name',
  'set_group_special_title',
  'set_group_leave',
  'set_group_remark',
  'handle_group_request',
  'handle_friend_request',
  'set_friend_remark',
  'delete_friend',
  'send_group_notice',
  'delete_group_notice',
  'set_msg_reaction',
  'set_essence',
  'forward_message',
  'send_like',
  'delete_group_file',
  'create_group_folder',
  'delete_group_folder',
  'rename_group_folder',
  'move_group_file'
]);

// Methods without which a send cannot be trusted. Missing any of these means
// the bridge is talking to a kernel it does not understand, whatever the
// version string says.
const CRITICAL_METHODS = Object.freeze([
  'getMsgService.sendMsg',
  'getMsgService.addKernelMsgListener',
  'getMsgService.generateMsgUniqueId',
  'getMSFService.getServerTime'
]);

function isWriteAction(action) {
  return WRITE_ACTIONS.has(String(action || ''));
}

// An empty version is the attach/debug path, where the host never wrote one.
// It is reported as "unknown" rather than "untested": blocking writes there
// would break the documented debug workflow without protecting anybody.
function assessBridge(info, { allowUntested = false } = {}) {
  const source = info && typeof info === 'object' ? info : {};
  const version = String(source.qq_version || '');
  const profile = BUILD_PROFILES[version] || null;
  const missing = Array.isArray(source.capabilities && source.capabilities.missing)
    ? source.capabilities.missing.map(String)
    : [];
  const criticalMissing = CRITICAL_METHODS.filter((name) => missing.includes(name));
  const known = version ? !!profile : null;
  const tested = version ? !!profile : null;
  const writesBlocked = !!version && !profile && !allowUntested;
  const warnings = [];
  if (version && !profile) {
    warnings.push(
      `QQ ${version} is not a build this repository has tested; ` +
      (allowUntested
        ? 'writes are allowed because --allow-untested is set'
        : 'reads stay open, writes return 403 until --allow-untested'))
  }
  if (!version) {
    warnings.push('the bridge did not report a QQ version (debug attach path); version policy is off');
  }
  if (criticalMissing.length) {
    warnings.push('kernel is missing ' + criticalMissing.join(', ') +
      (allowUntested ? '' : '; writes are refused until --allow-untested'));
  }
  return {
    qqVersion: version,
    profile: profile ? profile.family : '',
    notes: profile ? profile.notes : '',
    known: known,
    tested: tested,
    allowUntested: !!allowUntested,
    writesBlocked: writesBlocked || (criticalMissing.length > 0 && !allowUntested),
    criticalMissing,
    missing,
    warnings
  };
}

function assertActionAllowed(action, assessment) {
  if (!isWriteAction(action)) return;
  const state = assessment || {};
  if (!state.writesBlocked) return;
  const error = new Error(
    'refusing write action "' + action + '" on an unverified QQ build' +
    (state.qqVersion ? ' (' + state.qqVersion + ')' : '') +
    (state.criticalMissing && state.criticalMissing.length
      ? ' missing ' + state.criticalMissing.join(', ')
      : '') +
    '; pass --allow-untested to override'
  );
  error.code = 'untested_version';
  error.action = String(action);
  throw error;
}

module.exports = {
  TESTED_QQ_VERSIONS,
  BUILD_PROFILES,
  WRITE_ACTIONS,
  CRITICAL_METHODS,
  isWriteAction,
  assessBridge,
  assertActionAllowed
};
