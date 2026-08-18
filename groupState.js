// ══════════════════════════════════════════════════════
//  💾 حالة الجروبات — حفظ/تحميل من ملف
// ══════════════════════════════════════════════════════

const fs = require('fs')
const path = require('path')

const groupStateFile = path.join(__dirname, '..', 'group_state.json')
let groupStates = loadGroupStates()

function loadGroupStates() {
  try {
    if (fs.existsSync(groupStateFile)) {
      return JSON.parse(fs.readFileSync(groupStateFile, 'utf8'))
    }
  } catch (e) {
    console.error('⚠️ تعذر تحميل group_state.json:', e.message)
  }
  return {}
}

function saveGroupStates() {
  try {
    fs.writeFileSync(groupStateFile, JSON.stringify(groupStates, null, 2), 'utf8')
  } catch (e) {
    console.error('⚠️ تعذر حفظ group_state.json:', e.message)
  }
}

function getGroupState(chatId) {
  if (!groupStates[chatId]) {
    groupStates[chatId] = { adminOnlyCommands: false }
    saveGroupStates()
  }
  return groupStates[chatId]
}

module.exports = {
  getGroupState,
  saveGroupStates,
}
