// js/main.js
// 바다·민물 통합 금어기 알리미 — 완전 무료, API 키 보호

(function () {
  'use strict';

  // ── 상태 ────────────────────────────────────────────────────────────────
  let currentWaterType = 'all';
  let currentImageBase64 = null;
  let userRegion = null;
  let userGPS = null;
  const TODAY = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  // ── 브라우저 세션 캐시 ────────────────────────────────────────────────
  const SESSION_KEY = 'fishCache_' + new Date().toDateString();
  function getSessionCache(key) {
    try {
      const store = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}');
      return store[key] || null;
    } catch { return null; }
  }
  function setSessionCache(key, data) {
    try {
      const store = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}');
      store[key] = data;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(store));
    } catch {}
  }

  // ── GPS ──────────────────────────────────────────────────────────────────
  function initGPS() {
    const gpsText = document.getElementById('gpsText');
    if (!navigator.geolocation) {
      gpsText.textContent = '위치 사용 불가';
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userGPS = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        userRegion = getRegionFromGPS(userGPS.lat, userGPS.lon);
        gpsText.textContent = userRegion;
      },
      () => { gpsText.textContent = '위치 권한 없음 (전국 기준 적용)'; },
      { timeout: 8000 }
    );
  }

  function getRegionFromGPS(lat, lon) {
    if (lat >= 33.0 && lat <= 34.0 && lon >= 126.0 && lon <= 127.0) return '제주특별자치도';
    if (lat >= 37.4 && lon >= 130.8) return '울릉도·독도';
    if (lat >= 37.0 && lon >= 129.0) return '경상북도';
    if (lat >= 35.5 && lat < 37.0 && lon >= 129.0) return '경상남도';
    if (lat >= 35.0 && lat < 37.0 && lon >= 126.5 && lon < 129.0) return '전라남도';
    if (lat >= 35.7 && lat < 37.0 && lon >= 126.0 && lon < 127.5) return '전라북도';
    if (lat >= 36.5 && lat < 37.8 && lon >= 126.0 && lon < 127.5) return '충청남도';
    if (lat >= 36.5 && lat < 37.8 && lon >= 127.5 && lon < 129.0) return '충청북도';
    if (lat >= 37.0 && lat < 38.3 && lon >= 126.0 && lon < 127.5) return '경기도';
    if (lat >= 37.8 && lon >= 127.0 && lon < 129.5) return '강원도';
    if (lat >= 37.5 && lon >= 126.7 && lon < 127.2) return '서울·인천';
    return '전국';
  }

  // ── 탭 전환 ──────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentWaterType = btn.dataset.type;
    });
  });

  // ── 사진 선택 ────────────────────────────────────────────────────────────
  function handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64Full = e.target.result;
      currentImageBase64 = base64Full.split(',')[1];

      const preview = document.getElementById('previewImg');
      const placeholder = document.getElementById('photoPlaceholder');
      preview.src = base64Full;
      preview.classList.remove('hidden');
      placeholder.classList.add('hidden');
      document.getElementById('analyzeBtn').disabled = false;
    };
    reader.readAsDataURL(file);
  }

  document.getElementById('cameraInput').addEventListener('change', (e) => handleImageFile(e.target.files[0]));
  document.getElementById('galleryInput').addEventListener('change', (e) => handleImageFile(e.target.files[0]));

  document.getElementById('photoArea').addEventListener('click', () => {
    document.getElementById('galleryInput').click();
  });

  // ── 분석 버튼 ────────────────────────────────────────────────────────────
  document.getElementById('analyzeBtn').addEventListener('click', () => {
    if (!currentImageBase64) return;
    sendToAPI({ imageBase64: currentImageBase64, waterType: currentWaterType });
  });

  // ── 키워드 검색 ──────────────────────────────────────────────────────────
  function doKeywordSearch() {
    const kw = document.getElementById('keywordInput').value.trim();
    if (!kw) { showToast('어종 이름을 입력해주세요.'); return; }
    sendToAPI({ fishName: kw, waterType: currentWaterType });
  }

  document.getElementById('keywordBtn').addEventListener('click', doKeywordSearch);
  document.getElementById('keywordInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') doKeywordSearch();
  });

  // ── 빠른 태그 ────────────────────────────────────────────────────────────
  document.querySelectorAll('.quick-tag').forEach((tag) => {
    tag.addEventListener('click', () => {
      const fish = tag.dataset.fish;
      const type = tag.dataset.type;
      document.getElementById('keywordInput').value = fish;
      document.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.type === type);
      });
      currentWaterType = type;
      sendToAPI({ fishName: fish, waterType: type });
    });
  });

  // ── API 호출 ─────────────────────────────────────────────────────────────
  async function sendToAPI(payload) {
    if (payload.fishName && !payload.imageBase64) {
      const cacheKey = `${payload.fishName}_${payload.waterType}_${userRegion || 'all'}`;
      const cached = getSessionCache(cacheKey);
      if (cached) {
        showResult(cached);
        return;
      }
    }

    showLoading(true, '어종을 분석하는 중...', payload.imageBase64 ? '📷 Fishial.AI → iNaturalist 순서로 시도합니다' : '🔤 DB 조회 중...');

    try {
      const body = {
        ...payload,
        region: userRegion,
        today: TODAY,
      };

      const response = await fetch('/api/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '서버 오류가 발생했습니다.');
      }

      if (payload.fishName && !payload.imageBase64) {
        const cacheKey = `${payload.fishName}_${payload.waterType}_${userRegion || 'all'}`;
        setSessionCache(cacheKey, data);
      }

      showResult(data);
    } catch (err) {
      showLoading(false);
      showToast('❌ ' + (err.message || '네트워크 오류. 다시 시도해주세요.'));
    }
  }

  // ── 결과 표시 ────────────────────────────────────────────────────────────
  function showResult(data) {
    showLoading(false);

    // 모달 먼저 열기
    const ro = document.getElementById('resultOverlay');
    ro.classList.remove('hidden');
    ro.style.display = 'flex';

    // 어종 사진 초기화
    const fishPhoto = document.getElementById('fishPhoto');
    const fishPhotoImg = document.getElementById('fishPhotoImg');
    fishPhoto.style.display = 'none';
    fishPhotoImg.src = '';

    // Wikipedia 사진 조회
    if (data.fishName) {
      fetch(`https://ko.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(data.fishName)}&prop=pageimages&format=json&pithumbsize=400&origin=*`)
        .then(r => r.json())
        .then(json => {
          const pages = json.query.pages;
          const page = Object.values(pages)[0];
          if (page.thumbnail && page.thumbnail.source) {
            fishPhotoImg.src = page.thumbnail.source;
            fishPhoto.style.setProperty('display', 'block', 'important');
          }
        })
        .catch(() => {});
    }

    // 상태 배지
    const badge = document.getElementById('statusBadge');
    if (data.closedSeasonActive) {
      badge.textContent = '🚫 지금은 금어기입니다';
      badge.className = 'status-badge danger';
    } else if (data.todayStatus === '체장확인필요') {
      badge.textContent = '📏 체장을 확인하세요';
      badge.className = 'status-badge caution';
    } else {
      badge.textContent = '✅ 포획 가능합니다';
      badge.className = 'status-badge safe';
    }

    // 어종 기본 정보
    document.getElementById('resultFishName').textContent = data.fishName || '—';
    document.getElementById('resultScientificName').textContent = data.scientificName || '';

    const waterBadge = document.getElementById('resultWaterType');
    if (data.waterType === 'fresh') {
      waterBadge.textContent = '🏞️ 민물';
      waterBadge.className = 'water-badge fresh';
    } else {
      waterBadge.textContent = '🌊 바다';
      waterBadge.className = 'water-badge sea';
    }

    // 금어기
    const csVal = document.getElementById('closedSeasonValue');
    if (data.closedSeason) {
      csVal.textContent = data.closedSeason;
      csVal.className = 'reg-value' + (data.closedSeasonActive ? ' active' : '');
    } else {
      csVal.textContent = '금어기 없음';
      csVal.className = 'reg-value none';
    }

    // 금지체장
    const msVal = document.getElementById('minSizeValue');
    if (data.minSize) {
      msVal.textContent = data.minSize + (data.minSizeUnit ? '\n(' + data.minSizeUnit + ')' : '');
      msVal.className = 'reg-value caution';
    } else {
      msVal.textContent = '제한 없음';
      msVal.className = 'reg-value none';
    }

    // 지역 주의
    const regionNote = document.getElementById('regionNote');
    if (data.regionNote) {
      document.getElementById('regionNoteText').textContent = data.regionNote;
      regionNote.classList.remove('hidden');
    } else {
      regionNote.classList.add('hidden');
    }

    // 어종 정보
    document.getElementById('resultHabitat').textContent = data.habitat || '—';
    document.getElementById('resultSeason').textContent = data.season || '—';
    document.getElementById('resultDescription').textContent = data.description || '—';

    // 유사어종
    const similarSection = document.getElementById('similarSection');
    const similarList = document.getElementById('similarList');
    if (similarSection && similarList) {
      similarList.innerHTML = '';
      if (data.similarFish && data.similarFish.length > 0) {
        similarSection.classList.remove('hidden');
        data.similarFish.forEach((sf) => {
          const div = document.createElement('div');
          div.className = 'similar-item';
          div.innerHTML = `<div class="similar-name">🐟 ${sf.name}</div><div class="similar-diff">${sf.difference}</div>`;
          similarList.appendChild(div);
        });
      } else {
        similarSection.classList.add('hidden');
      }
    }

    // 경고
    const warningBox = document.getElementById('warningBox');
    if (warningBox) {
      if (data.warning) {
        const warningText = document.getElementById('warningText');
        if (warningText) warningText.textContent = '⚠️ ' + data.warning;
        warningBox.classList.remove('hidden');
      } else {
        warningBox.classList.add('hidden');
      }
    }
  }

  // ── 모달 닫기 ────────────────────────────────────────────────────────────
  document.getElementById('closeResult').addEventListener('click', () => {
    const ro = document.getElementById('resultOverlay');
    ro.classList.add('hidden');
    ro.style.display = 'none';
  });

  // ── 로딩 ─────────────────────────────────────────────────────────────────
  function showLoading(show, msg = '', sub = '') {
    const overlay = document.getElementById('loadingOverlay');
    if (show) {
      document.getElementById('loadingMsg').textContent = msg;
      document.getElementById('loadingSource').textContent = sub;
      overlay.classList.remove('hidden');
    } else {
      overlay.classList.add('hidden');
    }
  }

  // ── 토스트 ───────────────────────────────────────────────────────────────
  function showToast(msg) {
    const toast = document.getElementById('errorToast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3500);
  }

  // ── 오늘 날짜 표시 ────────────────────────────────────────────────────────
  document.getElementById('todayDate').textContent = new Date().toLocaleDateString('ko-KR', {
    month: 'long', day: 'numeric'
  });

  // ── 초기화 ───────────────────────────────────────────────────────────────
  initGPS();
})();
