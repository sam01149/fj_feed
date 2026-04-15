# FJFeed - Financial News & AI Digest
Agregator berita finansial real-time dengan fitur ringkasan otomatis berbasis AI untuk trader forex, komoditas, dan ekuitas.

## Fitur Utama
- Live RSS Feed: Pembaruan berita real-time dari FinancialJuice dengan sistem caching internal (50 detik) untuk efisiensi request.
- AI Session Digest: Ringkasan naratif otomatis dalam Bahasa Indonesia dan Inggris untuk Sesi Asia, London, dan New York menggunakan model gemini-2.0-flash.
- Kategorisasi Berita: Klasifikasi otomatis ke dalam kategori Market Moving, Forex, Macro, Energy, Geopolitical, dll.
- Progressive Web App (PWA): Dapat diinstal di beranda (homescreen) dengan dukungan Service Worker untuk fungsionalitas offline terbatas.
- Sistem Notifikasi: Notifikasi push melalui browser untuk berita kategori 'Market Moving' dan ringkasan sesi baru.
- Background Sync: Sinkronisasi data di latar belakang menggunakan periodicSync (pada browser yang mendukung).
  
## Stack Teknologi
- Frontend: HTML5, CSS3 (Custom Variables, Flexbox, Animations), Vanilla JavaScript.
- Backend: Netlify Functions (Node.js).
- AI: Google Gemini API.
- Deployment: Netlify.
- Data Source: FinancialJuice RSS Feed.

## Struktur Direktori
├── index.html                # Antarmuka utama dan logika frontend
├── manifest.json             # Konfigurasi PWA
├── sw.js                     # Service Worker untuk background tasks
├── netlify.toml              # Konfigurasi build dan headers Netlify
└── netlify/
    └── functions/
        ├── rss.js            # Proxy RSS dengan mekanisme caching
        └── digest.js         # Logika integrasi AI Gemini untuk ringkasan
## Instalasi dan Deployment
1. <b> Clone Repositori </b>:
   git clone https://github.com/username/fjfeed.git
2. <b> Konfigurasi Environment Variable </b>:
   Tambahkan key berikut pada pengaturan environment variable di dashboard Netlify:
   GEMINI_API_KEY: API Key dari Google AI Studio.
3. <b> Deployment </b>:
   Hubungkan repositori ke Netlify. Build settings akan otomatis dibaca dari netlify.toml.

## Mekanisme Digest
Ringkasan otomatis dipicu pada waktu-waktu berikut (WIB):
- Sesi Asia: 06:55
- Sesi London: 13:55
- Sesi New York: 20:25

Jika API Key Gemini tidak tersedia atau gagal, sistem akan beralih ke mode <b> Fallback Auto-Digest </b> yang mengelompokkan berita berdasarkan kategori secara algoritmik.
