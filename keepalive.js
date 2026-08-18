// ══════════════════════════════════════════════════════
//  🌐 خادم بسيط جداً + تنشيط ذاتي — يمنع Render من إطفاء
//  البوت بعد 15 دقيقة خمول (خطة Render المجانية)
// ══════════════════════════════════════════════════════

const http = require('http')
const https = require('https')

// خادم HTTP صغير جداً — كل اللي يسويه إنه يرد "OK" لأي طلب. Render يحتاج خدمتك
// "تستمع" على منفذ (port) عشان يعتبرها Web Service شغالة فعلياً
function startKeepAliveServer(port = process.env.PORT || 3000) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('Bot is alive ✅')
    })
    .listen(port, () => {
      console.log(`🌐 خادم التنشيط شغال على المنفذ ${port}`)
    })
}

// كل بضع دقائق، البوت "يتصل بنفسه" عبر الإنترنت — هذا يخلي Render يشوف نشاطاً حقيقياً
// ولا يعتبر البوت خاملاً، فما يطفيه
function startSelfPing(url, intervalMs) {
  if (!url) {
    console.log('ℹ️ SELF_URL غير موجود — التنشيط الذاتي معطل (البوت راح ينطفي بعد خمول)')
    return
  }

  setInterval(() => {
    https
      .get(url, res => {
        console.log(`🔄 تنشيط ذاتي: ${res.statusCode}`)
      })
      .on('error', e => {
        console.error('⚠️ فشل التنشيط الذاتي:', e.message)
      })
  }, intervalMs)

  console.log(`🔁 التنشيط الذاتي مفعّل، كل ${Math.round(intervalMs / 60000)} دقيقة`)
}

module.exports = { startKeepAliveServer, startSelfPing }
