// api/identify.js
// 식별 구조: Fishial.AI → iNaturalist → Gemini → 식별 불가
// 규정 조회: 내장 DB (fishDB.json) 전용

const path  = require('path');
const fs    = require('fs');
const https = require('https');

function loadFishDB() {
  try {
    const dbPath = path.join(__dirname, '..', 'data', 'fishDB.json');
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    console.log('[FISH_DB] 로드 성공, 어종 수:', Object.keys(db).length);
    return db;
  } catch (e) {
    console.error('[FISH_DB] 로드 실패:', e.message);
    return {};
  }
}

function isClosedSeason(mm, dd, closedSeasonStr) {
  if (!closedSeasonStr) return false;
  const match = closedSeasonStr.match(/(\d+)월\s*(\d+)일\s*~\s*(\d+)월\s*(\d+)일/);
  if (!match) return false;
  const [, sm, sd, em, ed] = match.map(Number);
  const today = mm * 100 + dd;
  const start = sm * 100 + sd;
  const end   = em * 100 + ed;
  if (start <= end) return today >= start && today <= end;
  return today >= start || today <= end;
}

function lookupFishDB(name) {
  const FISH_DB = loadFishDB();
  if (!name) return null;
  const normalized = name.trim();
  let entry = null;
  let fishName = null;
  if (FISH_DB[normalized]) {
    entry = FISH_DB[normalized];
    fishName = normalized;
  } else {
    for (const [key, val] of Object.entries(FISH_DB)) {
      if (val.aliases && val.aliases.includes(normalized)) {
        entry = val;
        fishName = key;
        break;
      }
    }
  }
  if (!entry) return null;
  const now = new Date();
  const mm  = now.getMonth() + 1;
  const dd  = now.getDate();
  const active = entry.closedSeason ? isClosedSeason(mm, dd, entry.closedSeason) : false;
  return { ...entry, fishName, closedSeasonActive: active, source: 'db' };
}

function buildDbResponse(dbResult, overrides = {}) {
  const { closedSeason, closedSeasonActive, minSize, minSizeUnit, minSizeNote } = dbResult;
  const todayStatus = closedSeasonActive ? '포획금지' : minSize ? '체장확인필요' : '포획가능';
  return {
    fishName:           dbResult.fishName,
    scientificName:     overrides.scientificName || dbResult.scientificName || null,
    waterType:          dbResult.waterType,
    confidence:         overrides.confidence ?? 1.0,
    source:             'db',
    _identifySource:    overrides.identifySource || null,
    closedSeason:       closedSeason || null,
    closedSeasonActive: closedSeasonActive,
    todayStatus,
    minSize:            minSize || null,
    minSizeUnit:        minSizeUnit || null,
    minSizeNote:        minSizeNote || null,
    regionNote:         dbResult.regionNote  || null,
    habitat:            dbResult.habitat     || null,
    season:             dbResult.season      || null,
    description:        dbResult.description || null,
    similarFish:        dbResult.similarFish || [],
    warning:            dbResult.warning     || null,
    dataSource:         '해양수산부 수산자원관리법 시행령 (2026.1.1. 기준)',
  };
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function identifyWithFishial(imageBase64) {
  try {
    const res = await fetchJson('https://api-recognition.fishial.ai/v2/recognition', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ image: imageBase64 }),
    });
    if (res.status === 200 && res.body?.data?.length > 0) {
      const top = res.body.data[0];
      if (top.score >= 0.70) {
        return { source: 'fishial', name: top.fish_name || top.name, confidence: Math.round(top.score * 100) };
      }
    }
    return null;
  } catch { return null; }
}

async function identifyWithINaturalist(imageBase64) {
  try {
    const boundary  = '----FormBoundary' + Math.random().toString(36).slice(2);
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const bodyStart = Buffer.from([
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="image"; filename="fish.jpg"\r\n`,
      `Content-Type: image/jpeg\r\n\r\n`,
    ].join(''));
    const bodyEnd  = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fullBody = Buffer.concat([bodyStart, imageBuffer, bodyEnd]);
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.inaturalist.org',
        path:     '/v2/computervision/score_image?fields=taxon.name,taxon.preferred_common_name,score',
        method:   'POST',
        headers:  { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': fullBody.length },
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.write(fullBody);
      req.end();
    });
    if (result.status === 200 && result.body?.results?.length > 0) {
      const top = result.body.results[0];
      if (top.score >= 0.60) {
        return { source: 'inaturalist', name: top.taxon?.preferred_common_name || top.taxon?.name, scientificName: top.taxon?.name, confidence: Math.round(top.score * 100) };
      }
    }
    return null;
  } catch { return null; }
}

async function identifyWithGemini(imageBase64) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    const res = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents: [{
            parts: [
              { text: '이 사진에 있는 물고기 또는 수산물의 한국어 이름을 정확히 한 단어로만 답해주세요. 예: 농어, 갑오징어, 꽃게. 물고기가 없으면 "없음"이라고만 답해주세요.' },
              { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }
            ]
          }]
        })
      }
    );
    if (res.status === 200 && res.body?.candidates?.[0]?.content?.parts?.[0]?.text) {
      const name = res.body.candidates[0].content.parts[0].text.trim();
console.log('[Gemini] 응답:', name);
if (name && name !== '없음') {
  return { source: 'gemini', name, confidence: 85 };
}

    }
    return null;
  } catch { return null; }
}

const CACHE_TTL = 0;
function getCached(key) { return null; }
function setCache(key, data) {}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, fishName, region, waterType, today } = req.body || {};

  if (!imageBase64 && !fishName) {
    return res.status(400).json({ error: '이미지 또는 어종명이 필요합니다.' });
  }

  if (fishName && !imageBase64) {
    const cacheKey = `${fishName}_${region || 'all'}_${waterType || 'all'}_${today}`;
    const cached   = getCached(cacheKey);
    if (cached) return res.status(200).json({ ...cached, _cached: true });
    const dbResult = lookupFishDB(fishName);
    if (dbResult) {
      const response = buildDbResponse(dbResult);
      setCache(cacheKey, response);
      return res.status(200).json(response);
    }
    const suggestions = {
      '문어': ['참문어', '대문어'],
      '오징어': ['살오징어', '갑오징어'],
      '게': ['꽃게', '대게', '붉은대게'],
      '새우': ['대하', '보리새우'],
      '조개': ['키조개', '새조개', '코끼리조개'],
      '가자미': ['문치가자미', '참가자미', '용가자미', '기름가자미'],
    };
    const relatedFish = suggestions[fishName] || [];
    return res.status(200).json({
      fishName, scientificName: null, waterType: waterType || null, confidence: null,
      source: 'not_found', closedSeason: null, closedSeasonActive: null, todayStatus: '정보없음',
      minSize: null, regionNote: null, habitat: null, season: null, description: null,
      similarFish: [], warning: null, suggestions: relatedFish,
      message: relatedFish.length > 0 ? `'${fishName}'은(는) DB에 없습니다. 아래 어종을 선택해 주세요.` : `'${fishName}'은(는) DB에 없습니다.`,
      dataSource: null,
    });
  }

let identified = null;
identified = await identifyWithGemini(imageBase64);


  if (!identified) {
    return res.status(422).json({
      error: '어종을 식별하지 못했습니다.',
      message: '더 선명하고 가까운 사진으로 다시 시도해 주세요.',
    });
  }

  const dbResult = lookupFishDB(identified.name);
  if (dbResult) {
    return res.status(200).json(buildDbResponse(dbResult, {
      scientificName: identified.scientificName,
      confidence:     identified.confidence,
      identifySource: identified.source,
    }));
  }

  return res.status(200).json({
    fishName: identified.name, scientificName: identified.scientificName || null,
    confidence: identified.confidence, source: 'identify_only', _identifySource: identified.source,
    closedSeason: null, closedSeasonActive: null, todayStatus: '정보없음',
    minSize: null, regionNote: null, habitat: null, season: null, description: null,
    similarFish: [], warning: null,
    message: 'DB에 등록되지 않은 어종입니다. 해양수산부(www.mof.go.kr)에서 확인해 주세요.',
    dataSource: null,
  });
};
