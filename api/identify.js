// api/identify.js
// 다중 API 폴백 구조: Fishial.AI → iNaturalist → Gemini Flash-Lite → Gemini Flash
// 민물/바다 통합, 완전 무료, API 키 서버사이드 보호

const https = require('https');

// ── 유틸: HTTPS fetch (Node 18 미만 대응) ──────────────────────────────────
function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
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

// ── 1순위: Fishial.AI (바다 어종 특화, 무제한 무료) ────────────────────────
async function identifyWithFishial(imageBase64) {
  try {
    const body = JSON.stringify({ image: imageBase64 });
    const res = await fetchJson('https://api-recognition.fishial.ai/v2/recognition', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body,
    });
    if (res.status === 200 && res.body?.data?.length > 0) {
      const top = res.body.data[0];
      if (top.score >= 0.70) {
        return {
          source: 'fishial',
          name: top.fish_name || top.name,
          confidence: Math.round(top.score * 100),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── 2순위: iNaturalist Vision API (민물 어종 강점, 무제한 무료) ────────────
async function identifyWithINaturalist(imageBase64) {
  try {
    // iNaturalist는 multipart/form-data 필요 → base64를 blob URL로 우회
    // 실제 구현: 이미지 URL 방식 사용 (base64 직접 전송은 미지원)
    // 여기서는 iNaturalist Identify API (taxon_id 없이 전체 검색)
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    
    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="image"; filename="fish.jpg"\r\n`,
      `Content-Type: image/jpeg\r\n\r\n`,
    ];
    const bodyEnd = `\r\n--${boundary}--\r\n`;
    const bodyStart = Buffer.from(bodyParts.join(''));
    const bodyEndBuf = Buffer.from(bodyEnd);
    const fullBody = Buffer.concat([bodyStart, imageBuffer, bodyEndBuf]);

    const urlObj = new URL('https://api.inaturalist.org/v2/computervision/score_image');
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + '?fields=taxon.name,taxon.preferred_common_name,score',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length,
      },
    };

    const result = await new Promise((resolve, reject) => {
      const req = https.request(reqOptions, (res) => {
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
        return {
          source: 'inaturalist',
          name: top.taxon?.preferred_common_name || top.taxon?.name,
          scientificName: top.taxon?.name,
          confidence: Math.round(top.score * 100),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── 3·4순위: Gemini (식별 + 금어기/금지체장 통합 조회) ─────────────────────
// 모델 우선순위: gemini-3-flash-preview → gemini-2.5-flash → gemini-2.0-flash
const GEMINI_MODELS = [
  'gemini-3-flash-preview', 
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];


async function callGemini(apiKey, model, prompt, imageBase64 = null) {
  const parts = [];
  if (imageBase64) {
    parts.push({
      inline_data: { mime_type: 'image/jpeg', data: imageBase64 },
    });
  }
  parts.push({ text: prompt });

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.1,
    },
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (res.status === 200) {
    const text = res.body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      try {
        const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(cleaned);
      } catch { return null; }
    }
  }
  // 429 = 한도 초과 → 다음 모델로 폴백
  if (res.status === 429) return { _rateLimited: true };
  return null;
}

async function identifyAndGetRegulationWithGemini(apiKey, imageBase64, fishName, region, waterType, today) {
  const regionText = region ? `현재 위치: ${region}` : '';
  const waterText = waterType === 'fresh' ? '민물(내수면)' : waterType === 'sea' ? '바다(해수면)' : '바다 또는 민물';

  // 이미지가 있으면 식별 포함, 없으면 규정만 조회
  const identifyPart = imageBase64 && !fishName
    ? `1. 이 사진의 물고기 어종을 식별해주세요.`
    : `1. 어종: ${fishName}`;

  const prompt = `
당신은 한국 수산자원 전문가입니다.
${identifyPart}
2. ${waterText} 어종을 대상으로 합니다.
3. ${regionText}
4. 오늘 날짜: ${today}
5. 아래 법령 기준으로 금어기와 금지체장을 정확히 알려주세요:
   - 바다: 수산자원관리법 시행령 별표1(금어기), 별표2(금지체장) 
   - 민물: 내수면어업법 시행령 별표1
6. 지역별 차이가 있는 경우 ${region || '전국 기준'}으로 답해주세요.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "fishName": "한국어 어종명",
  "scientificName": "학명",
  "waterType": "sea 또는 fresh",
  "confidence": 식별신뢰도(0-100, 이미지없으면 100),
  "closedSeasonActive": true 또는 false (오늘 날짜 기준),
  "closedSeason": "금어기 기간 (없으면 null)",
  "minSize": "금지체장 (없으면 null)",
  "minSizeUnit": "측정 기준 (전장/항문장/두흉갑장 등, 없으면 null)",
  "todayStatus": "포획가능 또는 금어기중 또는 체장확인필요",
  "regionNote": "지역별 차이 설명 (없으면 null)",
  "similarFish": [
    {"name": "유사어종명", "difference": "구분 방법"}
  ],
  "habitat": "서식지",
  "season": "제철",
  "description": "특징 설명",
  "warning": "주의사항 (없으면 null)"
}`;

  for (const model of GEMINI_MODELS) {
    const result = await callGemini(apiKey, model, prompt, imageBase64 && !fishName ? imageBase64 : null);
    if (result && !result._rateLimited) {
      result._model = model;
      return result;
    }
    // 한도 초과 시 다음 모델로 자동 전환
  }
  return null;
}

// ── sessionStorage 키워드 캐시 (서버 측 메모리 캐시, 1시간) ─────────────────
const serverCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1시간

function getCached(key) {
  const entry = serverCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { serverCache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  serverCache.set(key, { data, time: Date.now() });
}

// ── 메인 핸들러 ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { imageBase64, fishName, region, waterType, today } = req.body || {};

  if (!imageBase64 && !fishName) {
    return res.status(400).json({ error: '이미지 또는 어종명이 필요합니다.' });
  }

  // ── 키워드 검색: 캐시 확인 ─────────────────────────────────────────────
  if (fishName && !imageBase64) {
    const cacheKey = `${fishName}_${region || 'all'}_${waterType || 'all'}_${today}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.status(200).json({ ...cached, _cached: true });
    }

    const result = await identifyAndGetRegulationWithGemini(apiKey, null, fishName, region, waterType, today);
    if (result) {
      setCache(cacheKey, result);
      return res.status(200).json(result);
    }
    return res.status(500).json({ error: 'AI 조회에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }

  // ── 사진 검색: 다중 폴백 ──────────────────────────────────────────────
  // 1순위: Fishial.AI (바다 어종, 무제한)
  let identified = null;
  if (waterType !== 'fresh') {
    identified = await identifyWithFishial(imageBase64);
  }

  // 2순위: iNaturalist (민물 강점, 무제한)
  if (!identified) {
    identified = await identifyWithINaturalist(imageBase64);
  }

  // 3·4순위: Gemini로 식별 + 규정 통합 조회
  if (!identified) {
    const result = await identifyAndGetRegulationWithGemini(
      apiKey, imageBase64, null, region, waterType, today
    );
    if (result) return res.status(200).json(result);
    return res.status(500).json({ error: '어종을 식별하지 못했습니다. 더 선명한 사진을 시도해주세요.' });
  }

  // 식별 성공 → Gemini로 규정 조회
  const finalResult = await identifyAndGetRegulationWithGemini(
    apiKey, null, identified.name, region, waterType, today
  );
  if (finalResult) {
    finalResult.confidence = identified.confidence;
    finalResult._identifySource = identified.source;
    return res.status(200).json(finalResult);
  }

  return res.status(500).json({ error: '규정 조회에 실패했습니다.' });
};
