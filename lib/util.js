// lib/util.js
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

module.exports = { clamp };

function normalizeTopic(value) {
  return String(value || '').trim().toLowerCase().replace(/[ـ\s]+/g, ' ').replace(/[،,]/g, '');
}
module.exports.normalizeTopic = normalizeTopic;
