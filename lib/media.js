// ══════════════════════════════════════════════════════
//  🎵 الوسائط — تحميل الأغاني + تحويل الملصقات
// ══════════════════════════════════════════════════════

const fs = require('fs')
const path = require('path')
const ffmpeg = require('fluent-ffmpeg')
const ytSearch = require('yt-search')
const { spawn } = require('child_process')
const { uniqueTempId } = require('./utils')

ffmpeg.setFfmpegPath('ffmpeg')

const TMP_DIR = path.join(__dirname, '..', 'tmp')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

// قالب تقدم مخصص بصيغة JSON صريحة نتحكم بها بالكامل، بدل الاعتماد على الحقول المنسقة
// الجاهزة من yt-dlp (موثقة أنها ترجع أحياناً "N/A")، حتى نضمن تحليلاً موثوقاً عبر الإصدارات
const PROGRESS_TEMPLATE = 'download:{"downloaded":%(progress.downloaded_bytes)s,"total":%(progress.total_bytes)s,"speed":%(progress.speed)s,"eta":%(progress.eta)s}'

async function searchAndDownloadSong(query, onProgress = null) {
  const results = await ytSearch(query)
  const video = results?.videos?.[0]

  if (!video) {
    throw new Error('ما لقيت نتائج')
  }

  const id = uniqueTempId()
  const tmpTemplate = path.join(TMP_DIR, `song_${id}`)

  await new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '-x', '--audio-format', 'mp3', '--audio-quality', '128K',
      '--newline',
      '--progress-template', PROGRESS_TEMPLATE,
      '-o', `${tmpTemplate}.%(ext)s`,
      video.url,
    ])

    let stderrOutput = ''
    let stdoutBuffer = ''

    proc.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() // نحتفظ بآخر سطر غير مكتمل للـ chunk التالي

      for (const line of lines) {
        if (!onProgress) continue
        try {
          const data = JSON.parse(line)
          const downloaded = Number(data.downloaded)
          const total = Number(data.total)
          if (Number.isFinite(downloaded) && Number.isFinite(total) && total > 0) {
            const percent = Math.min(100, Math.round((downloaded / total) * 100))
            const etaSeconds = Number.isFinite(Number(data.eta)) ? Number(data.eta) : null
            onProgress({ percent, etaSeconds })
          }
        } catch {
          // سطر غير JSON صالح (رسائل تشخيصية عادية من yt-dlp) — نتجاهله بصمت
        }
      }
    })

    proc.stderr.on('data', chunk => { stderrOutput += chunk.toString() })

    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderrOutput.slice(-500)}`))
    })
  }).catch(e => {
    console.error('🔴 خطأ تفصيلي من yt-dlp:', e.message)
    throw new Error('فشل تحميل الأغنية')
  })

  const rawFile = `${tmpTemplate}.mp3`

  if (!fs.existsSync(rawFile)) {
    throw new Error('ما لقيت الملف بعد التحميل')
  }

  // إعادة ترميز بصيغة CBR موحدة ونظيفة قبل الإرسال — بعض إصدارات yt-dlp تنتج
  // ملفات بترويسات أو bitrate متغير قد لا تتوافق بسلاسة مع رفع واتساب
  const cleanFile = `${tmpTemplate}_clean.mp3`
  let reencodeSucceeded = false

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(rawFile)
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .audioFrequency(44100)
        .audioChannels(2)
        .format('mp3')
        .on('end', resolve)
        .on('error', reject)
        .save(cleanFile)
    })
    reencodeSucceeded = true
  } catch (e) {
    console.error('🔴 فشلت إعادة ترميز الصوت، سنستخدم الملف الأصلي:', e.message)
    // إذا فشلت إعادة الترميز لأي سبب، نكمل بالملف الأصلي بدل ما نوقف العملية كاملة
  }

  // نحذف فقط الملف الذي لن نستخدمه، بعد أن حسمنا أيهما هو
  const finalFile = reencodeSucceeded ? cleanFile : rawFile
  const discardedFile = reencodeSucceeded ? rawFile : cleanFile
  if (fs.existsSync(discardedFile)) fs.unlinkSync(discardedFile)

  if (!fs.existsSync(finalFile)) {
    throw new Error('ما لقيت الملف بعد المعالجة')
  }

  const buffer = fs.readFileSync(finalFile)
  fs.unlinkSync(finalFile)

  return {
    buffer,
    title: video.title,
    duration: video.seconds || 0,
    thumbnail: video.thumbnail || video.image || '',
    url: video.url,
  }
}

const MAX_ANIMATED_STICKER_SECONDS = 6

// يحول صورة ثابتة إلى ملصق WebP ثابت
async function convertImageToSticker(imgBuffer) {
  const id = uniqueTempId()
  const tmpIn = path.join(TMP_DIR, `sticker_in_${id}.jpg`)
  const tmpOut = path.join(TMP_DIR, `sticker_out_${id}.webp`)

  fs.writeFileSync(tmpIn, imgBuffer)

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .outputOptions([
          '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
          '-quality', '90',
          '-loop', '0',
        ])
        .toFormat('webp')
        .on('end', resolve)
        .on('error', reject)
        .save(tmpOut)
    })

    return fs.readFileSync(tmpOut)
  } finally {
    if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn)
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut)
  }
}

// يحول فيديو أو GIF (يصل كفيديو من جهة واتساب) إلى ملصق WebP متحرك
async function convertVideoToSticker(videoBuffer) {
  const id = uniqueTempId()
  const tmpIn = path.join(TMP_DIR, `sticker_in_${id}.mp4`)
  const tmpOut = path.join(TMP_DIR, `sticker_out_${id}.webp`)

  fs.writeFileSync(tmpIn, videoBuffer)

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .outputOptions([
          '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=15',
          '-quality', '80',
          '-loop', '0',
          '-preset', 'default',
          '-an', // ملصقات واتساب لا تدعم صوت
          '-vsync', '0',
        ])
        .toFormat('webp')
        .on('end', resolve)
        .on('error', reject)
        .save(tmpOut)
    })

    return fs.readFileSync(tmpOut)
  } finally {
    if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn)
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut)
  }
}

// نقطة الدخول الموحدة: تفحص نوع الوسيط ومدته، وترفض بوضوح إذا تجاوز الحد بدل القص التلقائي
async function convertToSticker({ buffer, type, seconds = 0 }) {
  if (type === 'video') {
    if (seconds > MAX_ANIMATED_STICKER_SECONDS) {
      const err = new Error('video_too_long')
      err.code = 'VIDEO_TOO_LONG'
      err.maxSeconds = MAX_ANIMATED_STICKER_SECONDS
      throw err
    }
    return convertVideoToSticker(buffer)
  }
  return convertImageToSticker(buffer)
}

module.exports = {
  searchAndDownloadSong,
  convertToSticker,
  MAX_ANIMATED_STICKER_SECONDS,
}
