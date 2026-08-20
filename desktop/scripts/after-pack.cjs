'use strict';

const rebuildRuntimeNative = require('./rebuild-runtime-native.cjs');
const applyFuses = require('./apply-fuses.cjs');

module.exports = async function afterPack(context) {
  await rebuildRuntimeNative(context);
  await applyFuses(context);
};
