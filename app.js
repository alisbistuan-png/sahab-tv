/* SAHAB TV - Vanilla JavaScript client (Updated with Smart Video Playback & Auto-Fallback). */
(() => {
  'use strict';

  const PREFS_KEY = 'SahabTV_Prefs';
  const BACKUP_KEY = 'sahabtv.web.catalog.v1';
  const DB_NAME = 'sahabtv_db';
  const DB_VERSION = 1;
  const PAGE_SIZE = 40;
  const API_TIMEOUT = 15000;
  const MEDIA_TIMEOUT = 30000;
  const TYPE = {
    movie: { store: 'vod_streams', title: 'الأفلام', categoryAction: 'get_vod_categories', listAction: 'get_vod_streams', id: 'stream_id' },
    series: { store: 'series', title: 'المسلسلات', categoryAction: 'get_series_categories', listAction: 'get_series', id: 'series_id' },
    live: { store: 'live_streams', title: 'القنوات المباشرة', categoryAction: 'get_live_categories', listAction: 'get_live_streams', id: 'stream_id' }
  };
  const state = {
    prefs: null, db: null, page: 'home', categoryId: '0', search: '', offset: 0,
    loading: false, hasMore: true, pageItems: [], categories: { movie: [], series: [], live: [] },
    itemByKey: new Map(), player: null, hls: null, activeMedia: null, toastTimer: null,
    syncPromise: null, observer: null, mediaTimer: null, fallbackTried: false, modeFallbackTried: false
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function getPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch { return null; }
  }
  function savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); }
  function toast(message) {
    const el = $('#toast'); if (!el) return; el.textContent = message; el.classList.add('show');
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove('show'), 3300);
  }
  function setLoginMessage(message, isError = true) {
    const el = $('#loginMessage'); if (!el) return; el.textContent = message; el.style.color = isError ? '#f48b8b' : '#82d6a9';
  }
  function normalizeServer(input) {
    let value = String(input || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
    const url = new URL(value);
    if (!url.hostname) throw new Error('تحقق من رابط السيرفر.');
    if (url.hostname.toLowerCase().includes('s58585.com')) return 'http://xmkvn.top:80';
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.replace(/\/$/, '');
  }
  function makeApiUrl(action, extra = {}) {
    const base = new URL(`${state.prefs.serverUrl}/player_api.php`);
    base.searchParams.set('username', state.prefs.username);
    base.searchParams.set('password', state.prefs.password);
    if (action) base.searchParams.set('action', action);
    Object.entries(extra).forEach(([key, value]) => base.searchParams.set(key, value));
    return base.href;
  }
  function wrapProxy(url) {
    const worker = (state.prefs?.proxyUrl || '').trim();
    if (!worker) return url;
    try {
      const proxy = new URL(worker);
      proxy.searchParams.set('url', url);
      return proxy.href;
    } catch {
      return url;
    }
  }
  async function requestJson(url, timeout = API_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(wrapProxy(url), { method: 'GET', signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error(`خطأ HTTP ${response.status}`);
      const data = await response.json();
      if (data && (data.error || data.message === 'Invalid credentials')) throw new Error(data.error || data.message);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('انتهت مهلة الاتصال (15 ثانية).');
      if (location.protocol === 'https:' && state.prefs.serverUrl.startsWith('http:') && !state.prefs.proxyUrl) {
        throw new Error('حظر المتصفح اتصال HTTP من صفحة HTTPS (Mixed Content). أضف رابط Cloudflare Worker وسيطاً من الإعدادات.');
      }
      if (error instanceof TypeError) throw new Error('تعذر الاتصال. تحقّق من CORS ورابط السيرفر، أو استخدم وسيط Cloudflare Worker.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function openDatabase() {
    if (!('indexedDB' in window)) return null;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [, cfg] of Object.entries(TYPE)) {
          if (!db.objectStoreNames.contains(cfg.store)) {
            const store = db.createObjectStore(cfg.store, { keyPath: 'id' });
            store.createIndex('categoryId', 'categoryId', { unique: false });
            store.createIndex('name', 'name', { unique: false });
            store.createIndex('categoryId_name', ['categoryId', 'name'], { unique: false });
            store.createIndex('generation', 'generation', { unique: false });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function storeFor(type, mode = 'readonly') {
    if (!state.db) throw new Error('قاعدة البيانات المحلية غير متاحة.');
    return state.db.transaction(TYPE[type].store, mode).objectStore(TYPE[type].store);
  }
  function toArray(data) { return Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []); }
  function normalizeItem(type, raw, generation) {
    const config = TYPE[type];
    const id = raw[config.id] ?? raw.streamId ?? raw.seriesId ?? raw.id;
    if (id === undefined || id === null) return null;
    const item = {
      id: String(id), name: String(raw.name || raw.title || `${type} ${id}`),
      categoryId: String(raw.category_id ?? raw.categoryId ?? '0'),
      lastUpdated: Date.now(), generation
    };
    if (type === 'movie') Object.assign(item, {
      streamId: String(id), streamIcon: raw.stream_icon || raw.cover || '', streamType: raw.stream_type || 'movie',
      containerExtension: String(raw.container_extension || 'mp4').replace(/^\./, '')
    });
    if (type === 'series') Object.assign(item, { seriesId: String(id), cover: raw.cover || raw.stream_icon || '' });
    if (type === 'live') Object.assign(item, {
      streamId: String(id), streamIcon: raw.stream_icon || '', epgChannelId: raw.epg_channel_id || '', streamType: raw.stream_type || 'live'
    });
    return item;
  }
  function normalizedCategories(data) {
    return toArray(data).map(item => ({ id: String(item.category_id ?? item.id ?? '0'), name: String(item.category_name || item.name || 'تصنيف') }));
  }
  async function fetchCategories(type) {
    const cfg = TYPE[type];
    const result = await requestJson(makeApiUrl(cfg.categoryAction));
    return normalizedCategories(result);
  }
  async function fetchList(type, categoryId = '0') {
    const cfg = TYPE[type];
    const extra = categoryId !== '0' ? { category_id: categoryId } : {};
    return toArray(await requestJson(makeApiUrl(cfg.listAction, extra)));
  }
  function idbRequest(request) {
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  async function saveCatalog(type, raws, categoryId = '0') {
    const generation = Date.now();
    const records = raws.map(x => normalizeItem(type, x, generation)).filter(Boolean);
    if (state.db) {
      const writeStore = storeFor(type, 'readwrite');
      await Promise.all(records.map(item => idbRequest(writeStore.put(item))));
      const pruneStore = storeFor(type, 'readwrite');
      await new Promise((resolve, reject) => {
        const index = pruneStore.index('categoryId');
        const range = categoryId === '0' ? null : IDBKeyRange.only(String(categoryId));
        const cursorReq = index.openCursor(range);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return resolve();
          const old = cursor.value;
          if (old.generation < generation && (categoryId === '0' || old.categoryId === String(categoryId))) cursor.delete();
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    }
    await updateBackup(type, records, categoryId);
    return records.length;
  }
  async function getAllFromStore(type) {
    if (state.db) {
      try { return await idbRequest(storeFor(type).getAll()); } catch {}
    }
    try {
      const backup = JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}');
      return Array.isArray(backup[type]) ? backup[type] : [];
    } catch { return []; }
  }
  async function updateBackup(type, fresh, categoryId) {
    try {
      const backup = JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}');
      const existing = Array.isArray(backup[type]) ? backup[type] : [];
      const byId = new Map(existing.map(x => [String(x.id), x]));
      fresh.forEach(x => byId.set(String(x.id), x));
      const gen = fresh[0]?.generation || Date.now();
      let values = [...byId.values()].filter(x => categoryId === '0' ? x.generation >= gen : (String(x.categoryId) !== String(categoryId) || x.generation >= gen));
      values.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
      backup[type] = values.slice(0, 5000);
      localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
    } catch (error) { console.warn('LocalStorage backup could not be updated:', error); }
  }
  async function queryLocal(type, categoryId, search, offset, limit) {
    if (!state.db) {
      const rows = await getAllFromStore(type);
      const filtered = rows.filter(x => (categoryId === '0' || String(x.categoryId) === String(categoryId)) && (!search || x.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))).sort((a,b) => a.name.localeCompare(b.name, 'ar'));
      return { items: filtered.slice(offset, offset + limit), hasMore: filtered.length > offset + limit, total: filtered.length };
    }
    const store = storeFor(type);
    const idx = categoryId === '0' ? store.index('name') : store.index('categoryId_name');
    const range = categoryId === '0' ? null : IDBKeyRange.bound([String(categoryId), ''], [String(categoryId), '\uffff']);
    const out = []; let matched = 0; let more = false;
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(range, 'next');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const row = cursor.value;
        if (!search || row.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) {
          if (matched >= offset && out.length < limit) out.push(row);
          else if (matched >= offset + limit) { more = true; return resolve(); }
          matched++;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    let total = null;
    if (!search) {
      try { total = await idbRequest(categoryId === '0' ? store.count() : store.index('categoryId').count(IDBKeyRange.only(String(categoryId)))); } catch {}
    }
    return { items: out, hasMore: more || (total !== null && offset + out.length < total), total };
  }
  async function getCount(type, categoryId = '0') {
    if (!state.db) return (await getAllFromStore(type)).filter(x => categoryId === '0' || String(x.categoryId) === String(categoryId)).length;
    const store = storeFor(type);
    return idbRequest(categoryId === '0' ? store.count() : store.index('categoryId').count(IDBKeyRange.only(String(categoryId))));
  }

  async function runHomeSync() {
    $('#connectionLabel').textContent = 'جارٍ تحديث المكتبة';
    $('#networkNotice').classList.add('hidden');
    const tasks = Object.keys(TYPE).map(async type => {
      const [categories, raws] = await Promise.all([fetchCategories(type), fetchList(type)]);
      state.categories[type] = categories;
      await saveCatalog(type, raws, '0');
      return { type, count: raws.length };
    });
    const results = await Promise.allSettled(tasks);
    const failed = results.filter(x => x.status === 'rejected');
    $('#connectionLabel').textContent = failed.length === 3 ? 'غير متصل — الكاش المحلي' : 'متصل';
    if (failed.length) {
      $('#networkNotice').textContent = 'تعذّر تحديث بعض الأقسام. نعرض النسخة المحلية المتاحة، ويمكنك إعادة المحاولة من داخل القسم.';
      $('#networkNotice').classList.remove('hidden');
    }
    await renderHome();
    return results;
  }
  async function renderHome() {
    for (const type of Object.keys(TYPE)) {
      const result = await queryLocal(type, '0', '', 0, 18);
      renderCards(result.items, $(`#home${type[0].toUpperCase()}${type.slice(1)}`), type);
    }
    const all = [...await getAllFromStore('movie'), ...await getAllFromStore('series')];
    const hero = all.sort((a,b) => (b.lastUpdated || 0) - (a.lastUpdated || 0))[0];
    if (hero) {
      $('#heroTitle').innerHTML = `${escapeHtml(hero.name)}<br><span>على SAHAB TV</span>`;
      $('#heroDescription').textContent = 'اختيار مميز من مكتبتك. اكتشف التفاصيل وابدأ المشاهدة الآن.';
      $('#heroPlay').onclick = () => hero.seriesId ? openSeries(hero) : openMediaDetails(hero, 'movie');
    }
  }
  function cardKey(type, item) { return `${type}:${item.id}`; }
  function renderCards(items, target, type) {
    if (!target) return;
    items.forEach(item => state.itemByKey.set(cardKey(type, item), item));
    target.innerHTML = items.length ? items.map(item => cardHtml(type, item)).join('') : `<div class="loading-state"><span>${escapeHtml('لا توجد عناصر مخزنة بعد')}</span></div>`;
    bindCards(target);
  }
  function cardHtml(type, item) {
    const key = cardKey(type, item), img = type === 'series' ? item.cover : item.streamIcon;
    const initial = escapeHtml((item.name || 'S').trim().slice(0, 1));
    if (type === 'live') return `<article class="live-card" data-key="${escapeHtml(key)}" tabindex="0"><div class="live-logo">${img ? `<img loading="lazy" src="${escapeHtml(img)}" alt="" onerror="this.remove()">` : initial}</div><div><div class="card-title">${escapeHtml(item.name)}</div><div class="card-meta">● بث مباشر</div></div></article>`;
    return `<article class="media-card" data-key="${escapeHtml(key)}" tabindex="0"><div class="poster">${img ? `<img loading="lazy" src="${escapeHtml(img)}" alt="غلاف ${escapeHtml(item.name)}" onerror="this.style.display='none'">` : `<div class="poster-placeholder">${initial}</div>`}<div class="poster-shade"></div><span class="card-play"><svg><use href="#i-play"/></svg></span></div><div class="card-title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div><div class="card-meta">${type === 'series' ? 'مسلسل' : 'فيلم'}</div></article>`;
  }
  function bindCards(root) {
    $$('[data-key]', root).forEach(card => {
      const activate = () => {
        const [type, ...rest] = card.dataset.key.split(':'); const item = state.itemByKey.get(`${type}:${rest.join(':')}`); if (!item) return;
        if (type === 'live') playMedia(item, 'live'); else if (type === 'series') openSeries(item); else openMediaDetails(item, type);
      };
      card.onclick = activate; card.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
    });
  }
  function setPage(page) {
    state.page = page; state.categoryId = '0'; state.search = $('#globalSearch').value.trim(); state.offset = 0; state.hasMore = true;
    $('#homePage').classList.toggle('hidden', page !== 'home');
    $('#catalogPage').classList.toggle('hidden', page === 'home'); $$('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    const isCatalog = page !== 'home';
    $('#pageTitle').textContent = isCatalog ? TYPE[page].title : 'الرئيسية';
    $('#pageKicker').textContent = isCatalog ? 'تصفّح مكتبتك' : 'اكتشف عالمك';
    if (isCatalog) {
      $('#catalogTitle').textContent = TYPE[page].title;
      $('#catalogKicker').textContent = page === 'live' ? 'على الهواء الآن' : 'مكتبتك';
      $('#categorySelect').innerHTML = '<option value="0">كل التصنيفات</option>' + state.categories[page].map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
      $('#categorySelect').value = '0';
      loadCatalogPage(true);
    }
    $('.sidebar').classList.remove('open'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function loadCatalogPage(reset = false) {
    const type = state.page;
    if (!TYPE[type] || state.loading) return;
    if (reset) { state.offset = 0; state.hasMore = true; $('#catalogGrid').innerHTML = ''; $('#emptyState').classList.add('hidden'); }
    if (!state.hasMore && !reset) return;
    state.loading = true; $('#catalogLoading').classList.remove('hidden'); $('#retryButton').classList.add('hidden');
    try {
      const localPromise = queryLocal(type, state.categoryId, state.search, state.offset, PAGE_SIZE);
      const networkPromise = (reset ? Promise.all([fetchCategories(type), fetchList(type, state.categoryId)]) : Promise.resolve(null));
      let local = await localPromise;
      if (local.items.length) appendCatalog(local);
      if (reset) {
        try {
          const [categories, raws] = await networkPromise;
          state.categories[type] = categories;
          await saveCatalog(type, raws, state.categoryId);
          const select = $('#categorySelect');
          const current = state.categoryId;
          select.innerHTML = '<option value="0">كل التصنيفات</option>' + categories.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
          select.value = current;
          if (state.offset === 0) {
            $('#catalogGrid').innerHTML = ''; state.hasMore = true; state.offset = 0; state.pageItems = [];
            local = await queryLocal(type, state.categoryId, state.search, 0, PAGE_SIZE);
            appendCatalog(local);
          }
          $('#connectionLabel').textContent = 'متصل';
        } catch (error) {
          $('#connectionLabel').textContent = 'الكاش المحلي';
          if (!local.items.length) {
            $('#emptyState').classList.remove('hidden'); $('#retryButton').classList.remove('hidden');
            $('#emptyState p').textContent = `تعذّر تحميل البيانات: ${error.message}`;
          }
        }
      }
      if (!local.items.length && state.offset === 0 && !$('#catalogGrid').children.length) $('#emptyState').classList.remove('hidden');
      const count = await getCount(type, state.categoryId).catch(() => null);
      $('#resultCount').textContent = count === null ? '' : `${count.toLocaleString('ar')} عنصر`;
    } catch (error) {
      console.error(error); toast(error.message || 'تعذّر تحميل القسم.');
    } finally { state.loading = false; $('#catalogLoading').classList.add('hidden'); }
  }
  function appendCatalog(result) {
    if (!result) return;
    state.pageItems.push(...result.items);
    result.items.forEach(item => state.itemByKey.set(cardKey(state.page, item), item));
    $('#catalogGrid').insertAdjacentHTML('beforeend', result.items.map(item => cardHtml(state.page, item)).join(''));
    bindCards($('#catalogGrid')); state.offset += result.items.length; state.hasMore = result.hasMore;
  }
  function installObserver() {
    if (!('IntersectionObserver' in window)) return;
    state.observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && state.page !== 'home' && state.hasMore && !state.loading) loadCatalogPage(false);
    }, { rootMargin: '450px' });
    state.observer.observe($('#scrollSentinel'));
  }
  function openDialog(id) { const el = document.getElementById(id); if (el && !el.open) el.showModal(); }
  function closeDialog(id) { const el = document.getE
