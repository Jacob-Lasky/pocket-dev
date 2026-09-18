const CODEX_TURN_CLASSIFICATIONS = Object.freeze({
  completed: 'settled',
  interrupted: 'busy',
  failed: 'settled',
  inProgress: 'busy',
});
const CODEX_TURN_STATUSES = Object.freeze(Object.keys(CODEX_TURN_CLASSIFICATIONS));

function normalizeCodexTurnStatus(status) {
  return Object.hasOwn(CODEX_TURN_CLASSIFICATIONS, status) ? status : 'unknown';
}

function classifyCodexTurnStatus(status) {
  const normalized = normalizeCodexTurnStatus(status);
  return CODEX_TURN_CLASSIFICATIONS[normalized] || 'unknown';
}

module.exports = {
  CODEX_TURN_STATUSES,
  normalizeCodexTurnStatus,
  classifyCodexTurnStatus,
};
