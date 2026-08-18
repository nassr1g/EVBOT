# ══════════════════════════════════════════════════════
#  🐳 Dockerfile — بوت واتساب (EVBOT)
#  يبني بيئة كاملة: Node.js 20 + ffmpeg + yt-dlp + Python
#  مصمم للعمل على Hostless (أو أي منصة Docker أخرى: Render, Koyeb...)
# ══════════════════════════════════════════════════════

FROM node:20-bookworm-slim

# ── تثبيت أدوات النظام المطلوبة ──────────────────────────
# ffmpeg     : تحويل الملصقات (webp) وإعادة ترميز الأغاني (mp3)
# python3/pip: مطلوب لتشغيل yt-dlp
# curl       : لتحميل ثنائي yt-dlp مباشرة (أحدث نسخة، أدق من نسخة pip أحياناً)
# ca-certificates: مطلوب لطلبات HTTPS الصادرة (Tavily, Serper, تحميل الصور...)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── تثبيت yt-dlp كملف ثنائي مباشر (أبسط وأخف من pip install) ──
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version

WORKDIR /app

# ── تثبيت حزم npm أولاً (طبقة منفصلة تُخزَّن مؤقتاً، تسرّع البناءات اللاحقة) ──
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── نسخ باقي كود المشروع ──
COPY . .

# ── إنشاء المجلدات التي يحتاجها البوت وقت التشغيل ──
RUN mkdir -p tmp auth_info

# المنفذ الذي يستمع عليه خادم keepalive.js (Hostless يحقن PORT=8000 تلقائياً)
EXPOSE 8000

# أمر التشغيل الافتراضي (تقدر تتجاوزه من حقل Start Command في لوحة Hostless)
CMD ["node", "index.js"]
