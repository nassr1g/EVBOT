// سكربت تشخيصي مستقل — يسأل Gemini API مباشرة عن قائمة النماذج المتاحة فعلياً لهذا
// المفتاح بالذات، بدل الاعتماد على أي توثيق خارجي قد يكون غير دقيق لحالة حسابك.
//
// طريقة التشغيل:
//   node list_models.js
//
// شغّله من نفس مجلد المشروع (لازم يكون .env فيه GEMINI_API_KEY موجود بجانبه)

require('dotenv').config()

async function main() {
  const { GoogleGenAI } = await import('@google/genai')
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

  console.log('🔍 جاري جلب قائمة النماذج المتاحة لمفتاحك...\n')

  try {
    const models = await ai.models.list()
    let page = models.page
    let count = 0

    while (page.length > 0) {
      for (const model of page) {
        const supportsGenerate = model.supportedActions?.includes('generateContent')
        if (supportsGenerate) {
          count++
          console.log(`✅ ${model.name}`)
          console.log(`   الاسم المعروض: ${model.displayName || '(غير محدد)'}`)
          console.log(`   الإجراءات المدعومة: ${model.supportedActions?.join(', ')}`)
          console.log('')
        }
      }
      page = models.hasNextPage() ? await models.nextPage() : []
    }

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`إجمالي النماذج التي تدعم generateContent: ${count}`)
  } catch (err) {
    console.error('❌ فشل جلب قائمة النماذج:', err?.message || err)
  }
}

main()
