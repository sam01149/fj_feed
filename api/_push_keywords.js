// api/_push_keywords.js — keyword lists for push notification categorization
// Digunakan oleh detectPushCat() di admin.js
// Tambah/hapus kata di sini bebas — tidak ada batas baris, tidak mempengaruhi logika lain

module.exports = {

  // 🔴 Berita yang langsung menggerakkan pasar secara besar
  MARKET_MOVING: [
    'market moving', 'breaking', 'blockade',
    'flash crash', 'circuit breaker', 'trading halt', 'market halt',
    'emergency meeting', 'surprise rate', 'unexpected rate', 'shock decision',
    'market crash', 'market rout', 'market meltdown', 'market turmoil',
    'black swan', 'limit up', 'limit down',
    'catastrophic', 'unprecedented move', 'historic high', 'historic low',
    'all-time high', 'all-time low', 'record high', 'record low',
  ],

  // 💱 Mata uang, pair FX, gold/silver sebagai instrumen forex
  FOREX: [
    // pair notation
    'eur/', 'gbp/', 'usd/', 'aud/', 'nzd/', 'cad/', 'chf/', 'jpy/',
    '/usd', '/jpy', '/eur', '/gbp', '/aud', '/chf',
    // indices
    'dxy', 'dollar index', 'usdx', 'trade-weighted dollar',
    // currency nicknames
    'loonie', 'aussie', 'cable', 'kiwi', 'sterling', 'greenback', 'swissy',
    // currency names
    'yen', 'euro', 'pound', 'franc', 'yuan', 'renminbi', 'rupiah',
    // gold & silver (FX instruments XAU/USD, XAG/USD)
    'gold', 'xau', 'silver', 'xag',
    // dollar movement — verb variations
    'dollar rallies', 'dollar drops', 'dollar falls', 'dollar rises',
    'dollar weakens', 'dollar strengthens', 'dollar gains', 'dollar jumps',
    'dollar slides', 'dollar surges', 'dollar plunges', 'dollar rebounds',
    'dollar slips', 'dollar tumbles', 'dollar edges higher', 'dollar edges lower',
    'dollar retreats', 'dollar soars', 'dollar recovers', 'dollar steadies',
    // yen movement (sering headline tanpa pair)
    'yen rises', 'yen falls', 'yen weakens', 'yen strengthens', 'yen gains',
    'yen drops', 'yen surges', 'yen slides', 'yen hits', 'yen near',
    // euro movement
    'euro rises', 'euro falls', 'euro weakens', 'euro strengthens', 'euro gains',
    'euro drops', 'euro slides', 'euro surges', 'euro hits', 'euro near',
    // pound movement
    'pound rises', 'pound falls', 'pound weakens', 'pound strengthens', 'pound gains',
    'pound drops', 'pound slides', 'pound surges', 'pound hits', 'pound near',
    // FX market generic
    'fx market', 'forex market', 'currency pair', 'currency market', 'spot fx',
    'currency war', 'competitive devaluation', 'currency intervention',
    'fx intervention', 'verbal intervention', 'safe haven',
  ],

  // ⚡ Energi — minyak, gas, komoditas energi
  ENERGY: [
    'oil', 'crude', 'brent', 'wti', 'natural gas', 'hormuz', 'iea',
    'opec', 'opec+', 'opec cut', 'opec output', 'opec production',
    'lng', 'gasoline', 'petroleum', 'refinery', 'pipeline',
    'energy prices', 'oil prices', 'oil production', 'oil output',
    'oil supply', 'oil demand', 'oil inventory', 'oil stockpile',
    'shale', 'offshore drilling', 'rig count', 'baker hughes',
    'eia crude', 'api crude', 'crude inventories', 'gasoline inventories',
    'fuel prices', 'diesel', 'gas prices', 'heating oil',
  ],

  // 🏦 Bank sentral & kebijakan moneter
  MACRO: [
    // Fed / AS
    'fed ', 'fomc', 'powell', 'federal reserve', 'fed minutes', 'beige book',
    'fed funds', 'fed pivot', 'fed hold', 'fed pause',
    // ECB / Eropa
    'ecb', 'lagarde', 'european central bank', 'ecb minutes',
    // BOE / UK
    'boe', 'bailey', 'bank of england', 'mpc meeting',
    // BOJ / Jepang
    'boj', 'ueda', 'bank of japan', 'yield curve control', 'ycc',
    // PBOC / China
    'pboc', "people's bank of china", 'peoples bank of china',
    // RBA / Australia
    'rba', 'bullock', 'reserve bank of australia',
    // RBNZ / Selandia Baru
    'rbnz', 'orr', 'reserve bank of new zealand',
    // SNB / Swiss
    'snb', 'jordan', 'swiss national bank',
    // BOC / Kanada
    'boc', 'bank of canada', 'macklem',
    // Lainnya
    'norges bank', 'riksbank', 'reserve bank of india', 'rbi',
    // Keputusan & sinyal
    'rate cut', 'rate hike', 'rate decision', 'rate pause', 'rate hold',
    'rate outlook', 'policy rate', 'benchmark rate', 'overnight rate',
    'base rate', 'interest rate', 'monetary policy', 'central bank',
    'quantitative easing', 'qe ', ' qt ', 'quantitative tightening',
    'balance sheet', 'inflation target', 'inflation forecast',
    'hawkish', 'dovish', 'neutral stance',
    // Yield & obligasi (erat kaitannya dengan kebijakan moneter)
    'yield curve', 'bond yield', 'treasury yield', '10-year yield',
    'yield spread', 'inverted yield', '2-year yield', 'bond market',
  ],

  // 🌐 Geopolitik — konflik, sanksi, perdagangan, politik
  GEOPOLITICAL: [
    // Negara / aktor konflik
    'iran', 'israel', 'russia', 'ukraine', 'china', 'trump', 'nato',
    'taiwan', 'north korea', 'korea', 'middle east', 'red sea',
    'houthi', 'hamas', 'hezbollah',
    // Peristiwa geopolitik
    'war', 'ceasefire', 'peace talks', 'military', 'invasion',
    'airstrike', 'missile', 'nuclear', 'sanctions', 'blockade',
    // Perdagangan internasional
    'tariff', 'trade deal', 'trade war', 'trade tension',
    'import duty', 'export ban', 'embargo', 'trade deficit', 'trade surplus',
    // Forum internasional
    'g7', 'g20', 'imf', 'world bank', 'wto', 'un security',
    // Politik domestik berdampak pasar
    'election', 'referendum', 'coup', 'government shutdown',
    'debt ceiling', 'fiscal cliff',
  ],

  // 📋 Data ekonomi — rilis & indikator makro
  ECON_DATA: [
    // Penanda rilis (dari feed FinancialJuice)
    'actual', 'forecast', 'previous',
    // AS
    'cpi', 'nfp', 'unemployment', 'payroll', 'jobs report', 'job openings',
    'jolts', 'adp employment', 'initial claims', 'jobless claims', 'continuing claims',
    'average hourly earnings', 'participation rate', 'labor force',
    'pce', 'core inflation', 'core cpi', 'core pce',
    'gdp', 'gdp growth', 'gdp estimate', 'gdp revised',
    'retail sales', 'consumer spending', 'personal spending', 'personal income',
    'pmi', 'ism ', 'manufacturing pmi', 'services pmi', 'composite pmi',
    'durable goods', 'factory orders', 'industrial production', 'capacity utilization',
    'trade balance', 'current account', 'trade deficit', 'trade surplus',
    'housing starts', 'building permits', 'existing home sales', 'new home sales',
    'consumer confidence', 'consumer sentiment', 'michigan sentiment',
    'chicago pmi', 'producer price', 'ppi',
    // Internasional
    'flash pmi', 'caixin', 'ifo', 'zew', 'gfk',
    'unemployment rate', 'employment change', 'wage growth',
    'inflation rate', 'inflation data', 'inflation report',
    'budget deficit', 'fiscal deficit', 'government debt',
  ],

};
