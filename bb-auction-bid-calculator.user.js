// ==UserScript==
// @name         BB Auction Bid Calculator
// @namespace    tornjunkie.bbauction
// @version      1.4.0
// @description  Set price per bunker buck on the auction house and get max bid values by weapon category and rarity
// @author       Scolli03[3150751]
// @updateURL    https://scriptserver.tornjunkie.com/?script=bbauction
// @downloadURL  https://scriptserver.tornjunkie.com/?script=bbauction
// @match        https://www.torn.com/amarket.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      www.torn.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const PREFIX = 'bb-auction';
    const BRAND_NAME = 'Torn Junk(ie)';
    const BRAND_CREDIT = 'Scolli03[3150751]';
    const SK = {
        pricePerBB: 'bbAuction_pricePerBB',
        categoryCache: 'bbAuction_categoryCache_v2',
        itemCatalog: 'bbAuction_itemCatalog_v1',
        bbTable: 'bbAuction_bbTable_v1',
        dollarTable: 'bbAuction_dollarTable_v1',
        apiKey: 'bbAuctionTornApiKey',
        apiKeyPrompted: 'bbAuction_apiKeyPrompted',
        debug: 'bbAuction_debug'
    };
    const UNKNOWN_CATEGORY = '__unknown__';
    const PDA_API_KEY_PLACEHOLDER = '###PDA-APIKEY###';
    /** Replaced at runtime by Torn PDA when user sets a key in script manager. */
    let RUNTIME_API_KEY = PDA_API_KEY_PLACEHOLDER;
    const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    /** v2 API categories — weapons + armor only (~300 items, 2 requests). Cached 7 days. */
    const CATALOG_V2_CATEGORIES = ['Weapon', 'Defensive'];
    const CATALOG_MIN_ITEMS = 15;
    const API_MIN_GAP_MS = 400;

    const CATEGORY_LABELS = {
        pistolSmg: 'Pistol/SMG',
        melee: 'Melee',
        rifleShotgun: 'Rifle/Shotgun',
        armor: 'Armor',
        heavyArtillery: 'Heavy Artillery/Machine Gun'
    };

    const CATEGORY_LABELS_SHORT = {
        pistolSmg: 'Pistol/SMG',
        melee: 'Melee',
        rifleShotgun: 'Rifle/Shotgun',
        armor: 'Armor',
        heavyArtillery: 'Heavy Art./MG'
    };

    /** Default BB multipliers from customer BUY TABLE (reference $5.7m/BB). */
    const DEFAULT_BB_TABLE = {
        pistolSmg: { yellow: 4, orange1: 12, orange2: 23.263157894736842, red1: 36, red2: 54 },
        melee: { yellow: 6, orange1: 18, orange2: 34.89473684210526, red1: 54, red2: 81 },
        rifleShotgun: { yellow: 10, orange1: 30, orange2: 58.157894736842105, red1: 90, red2: 135 },
        armor: { yellow: 8.5, orange1: 26.026315789473684, red1: 108 },
        heavyArtillery: { yellow: 14, orange1: 42, orange2: 63, red1: 126, red2: 189 }
    };

    const WEAPON_ROWS = ['pistolSmg', 'melee', 'rifleShotgun', 'heavyArtillery'];
    const WEAPON_COLS = [
        { key: 'yellow', label: 'Yellow', rarity: 'yellow' },
        { key: 'orange1', label: 'Orange (1)', rarity: 'orange' },
        { key: 'orange2', label: 'Orange (2)', rarity: 'orange' },
        { key: 'red1', label: 'Red (1)', rarity: 'red' },
        { key: 'red2', label: 'Red (2)', rarity: 'red' }
    ];
    const ARMOR_COLS = [
        { key: 'yellow', label: 'Yellow', rarity: 'yellow' },
        { key: 'orange1', label: 'Orange', rarity: 'orange' },
        { key: 'red1', label: 'Red', rarity: 'red' }
    ];
    const RARITY_COLORS = { yellow: '#eab308', orange: '#f97316', red: '#ef4444' };

    const state = {
        pricePerBB: null,
        bbTable: null,
        dollarTable: {},
        categoryCache: {},
        itemCatalog: {},
        itemCatalogLoaded: false,
        itemCatalogLoading: null,
        categoryPending: {},
        listObserver: null,
        infoObserver: null,
        refreshTimer: null,
        refreshInFlight: false,
        topBarObserver: null,
        bidPanelObserver: null,
        bidPanelBound: false,
        bidScanTimer: null,
        tabRefreshTimer: null,
        observersPaused: false,
        isPDA: false,
        itemCatalogError: null,
        lastApiAt: 0,
        debug: false
    };

    function log(...args) {
        if (state.debug) console.log('[BB Auction]', ...args);
    }

    function warn(...args) {
        console.warn('[BB Auction]', ...args);
    }

    // ---------- storage ----------

    function storeGet(key, fallback) {
        try {
            if (typeof GM_getValue !== 'undefined') {
                const v = GM_getValue(key, fallback);
                return v === undefined ? fallback : v;
            }
        } catch (e) { /* ignore */ }
        try {
            const raw = localStorage.getItem(key);
            if (raw == null) return fallback;
            return JSON.parse(raw);
        } catch (e2) {
            return fallback;
        }
    }

    function storeSet(key, value) {
        try {
            if (typeof GM_setValue !== 'undefined') {
                GM_setValue(key, value);
                return;
            }
        } catch (e) { /* ignore */ }
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e2) { /* ignore */ }
    }

    function loadCategoryCache() {
        state.categoryCache = storeGet(SK.categoryCache, {}) || {};
    }

    function saveCategoryCache() {
        storeSet(SK.categoryCache, state.categoryCache);
    }

    function cloneDefaultBbTable() {
        return JSON.parse(JSON.stringify(DEFAULT_BB_TABLE));
    }

    function loadBbTableFromStorage() {
        const saved = storeGet(SK.bbTable, null);
        if (!saved) return cloneDefaultBbTable();
        const table = cloneDefaultBbTable();
        Object.keys(saved).forEach(cat => {
            if (!table[cat]) table[cat] = {};
            Object.assign(table[cat], saved[cat]);
        });
        return table;
    }

    function loadDollarTableFromStorage() {
        return storeGet(SK.dollarTable, {}) || {};
    }

    function saveBbTable() {
        storeSet(SK.bbTable, state.bbTable);
    }

    function saveDollarTable() {
        storeSet(SK.dollarTable, state.dollarTable);
    }

    function getBbCell(category, colKey) {
        const row = state.bbTable && state.bbTable[category];
        return row && row[colKey] != null ? row[colKey] : null;
    }

    function getDollarCell(category, colKey) {
        const overrides = state.dollarTable[category];
        if (overrides && overrides[colKey] != null) return overrides[colKey];
        const bb = getBbCell(category, colKey);
        if (bb == null || !state.pricePerBB) return null;
        return Math.floor(state.pricePerBB * bb);
    }

    function isPdaApiKeyPlaceholder(key) {
        return !key || String(key).trim() === '' || key === PDA_API_KEY_PLACEHOLDER;
    }

    async function checkTornPDA() {
        if (typeof window.flutter_inappwebview !== 'undefined' &&
            typeof window.flutter_inappwebview.callHandler === 'function') {
            try {
                const response = await window.flutter_inappwebview.callHandler('isTornPDA');
                return !!(response && response.isTornPDA === true);
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    function getCachedCategory(itemId) {
        const key = String(itemId);
        if (state.itemCatalog[key]) return state.itemCatalog[key];
        const val = state.categoryCache[key];
        if (val === UNKNOWN_CATEGORY) return null;
        return val || null;
    }

    function getApiKey() {
        if (!isPdaApiKeyPlaceholder(RUNTIME_API_KEY)) return String(RUNTIME_API_KEY).trim();
        const stored = storeGet(SK.apiKey, '');
        if (stored && String(stored).trim()) return String(stored).trim();
        const sharedKeys = ['tornApiKey', 'rwToolkitTornApiKey'];
        try {
            if (typeof GM_getValue !== 'undefined') {
                for (const k of sharedKeys) {
                    const v = GM_getValue(k, '');
                    if (v && String(v).trim()) return String(v).trim();
                }
            }
        } catch (e) { /* ignore */ }
        try {
            for (const k of sharedKeys) {
                const v = localStorage.getItem(k);
                if (v && String(v).trim()) return String(v).trim();
            }
        } catch (e2) { /* ignore */ }
        return null;
    }

    function saveApiKey(key) {
        storeSet(SK.apiKey, String(key || '').trim());
    }

    function promptForApiKeyModal() {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = PREFIX + '-overlay';
            overlay.innerHTML =
                '<div class="' + PREFIX + '-modal ' + PREFIX + '-modal-api" role="dialog" aria-modal="true">' +
                    '<div class="' + PREFIX + '-modal-head"><h2>Torn API key</h2></div>' +
                    '<div class="' + PREFIX + '-modal-body">' +
                        '<p class="' + PREFIX + '-modal-copy">Optional: loads weapon categories in one shot. A <b>Public</b> access key is enough for the items endpoint (Torn\'s lowest access level). Stored only in this browser.</p>' +
                        '<label class="' + PREFIX + '-field-label" for="' + PREFIX + '-api-key-input">API key</label>' +
                        '<input type="password" id="' + PREFIX + '-api-key-input" class="' + PREFIX + '-text-input" placeholder="Public access key" autocomplete="off">' +
                        '<div class="' + PREFIX + '-modal-actions">' +
                            '<button type="button" class="' + PREFIX + '-btn" data-action="skip">Skip</button>' +
                            '<button type="button" class="' + PREFIX + '-btn primary" data-action="save">Save</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                brandFooterHtml();

            const finish = val => {
                overlay.remove();
                document.body.style.overflow = '';
                resolve(val);
            };

            overlay.querySelector('[data-action="skip"]').addEventListener('click', () => finish(null));
            overlay.querySelector('[data-action="save"]').addEventListener('click', () => {
                const input = overlay.querySelector('#' + PREFIX + '-api-key-input');
                const val = input && input.value.trim();
                if (!val) {
                    input.focus();
                    return;
                }
                saveApiKey(val);
                finish(val);
            });
            overlay.addEventListener('click', e => {
                if (e.target === overlay) finish(null);
            });
            document.body.style.overflow = 'hidden';
            document.body.appendChild(overlay);
            const input = overlay.querySelector('#' + PREFIX + '-api-key-input');
            if (input) input.focus();
        });
    }

    async function ensureApiKey() {
        if (state.isPDA) {
            return getApiKey();
        }
        const existing = getApiKey();
        if (existing) return existing;
        if (storeGet(SK.apiKeyPrompted, false)) return null;
        storeSet(SK.apiKeyPrompted, true);
        return promptForApiKeyModal();
    }

    function tornRequest(url, asJson) {
        const fullUrl = url.startsWith('http') ? url : 'https://www.torn.com' + url;
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'undefined') {
                reject(new Error('GM_xmlhttpRequest unavailable — enable @grant GM_xmlhttpRequest in Tampermonkey'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: fullUrl,
                onload(resp) {
                    if (resp.status >= 200 && resp.status < 300) {
                        if (asJson) {
                            try {
                                resolve(JSON.parse(resp.responseText));
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            resolve(resp.responseText);
                        }
                    } else {
                        reject(new Error('HTTP ' + resp.status + ' for ' + fullUrl));
                    }
                },
                onerror: () => reject(new Error('Network error for ' + fullUrl))
            });
        });
    }

    function apiRequest(url) {
        return tornRequest(url, true).then(data => {
            if (data && data.error) {
                const msg = data.error.error || data.error.message || JSON.stringify(data.error);
                throw new Error(msg);
            }
            return data;
        });
    }

    function categoryFromTornItem(item) {
        if (!item) return null;
        const type = String(item.type || '').toLowerCase();
        const sub = item.sub_type || item.subType || '';
        if (type === 'defensive' || type === 'armor') return 'armor';
        const fromSub = mapSubTypeToCategory(sub);
        if (fromSub) return fromSub;
        const detailsCat = item.details && item.details.category;
        if (detailsCat) {
            const dc = String(detailsCat).toLowerCase();
            if (dc === 'melee') return 'melee';
        }
        if (type === 'weapon' || type === 'melee') return mapSubTypeToCategory(sub);
        return null;
    }

    async function apiThrottle() {
        const elapsed = Date.now() - state.lastApiAt;
        if (elapsed < API_MIN_GAP_MS) {
            await new Promise(r => setTimeout(r, API_MIN_GAP_MS - elapsed));
        }
        state.lastApiAt = Date.now();
    }

    async function fetchV2ItemsByCategory(key, cat) {
        const map = {};
        let offset = 0;
        const limit = 1000;
        while (true) {
            await apiThrottle();
            const data = await apiRequest(
                'https://api.torn.com/v2/torn/items?cat=' + encodeURIComponent(cat) +
                '&limit=' + limit + '&offset=' + offset + '&key=' + encodeURIComponent(key)
            );
            const batch = buildItemCatalog({ items: data.items || [] });
            Object.assign(map, batch);
            const count = (data.items || []).length;
            if (count < limit) break;
            offset += limit;
        }
        return map;
    }

    async function fetchItemCatalogFromApi(key) {
        const map = {};
        try {
            for (const cat of CATALOG_V2_CATEGORIES) {
                const batch = await fetchV2ItemsByCategory(key, cat);
                Object.assign(map, batch);
                log('catalog category', cat, Object.keys(batch).length);
            }
            const count = Object.keys(map).length;
            if (count >= CATALOG_MIN_ITEMS) {
                log('item catalog from v2 (Weapon+Defensive)', count, 'api calls:', CATALOG_V2_CATEGORIES.length);
                return map;
            }
        } catch (err) {
            log('v2 filtered catalog failed, trying v1', err);
        }

        await apiThrottle();
        const v1 = await apiRequest('https://api.torn.com/torn/?selections=items&key=' + encodeURIComponent(key));
        const filtered = buildItemCatalog(v1);
        const count = Object.keys(filtered).length;
        if (count >= CATALOG_MIN_ITEMS) {
            log('item catalog from v1 (weapons/armor only)', count, 'api calls: 1');
            return filtered;
        }
        throw new Error('Catalog too small (' + count + '). A Public access key is sufficient.');
    }

    function buildItemCatalog(itemsPayload) {
        const map = {};
        if (!itemsPayload) return map;
        const items = itemsPayload.items || itemsPayload;
        if (Array.isArray(items)) {
            items.forEach(item => {
                if (!item || item.id == null) return;
                const cat = categoryFromTornItem(item);
                if (cat) map[String(item.id)] = cat;
            });
        } else if (typeof items === 'object') {
            Object.keys(items).forEach(id => {
                const item = items[id];
                const cat = categoryFromTornItem(item);
                if (cat) map[String(id)] = cat;
            });
        }
        return map;
    }

    function loadItemCatalog(force) {
        if (state.itemCatalogLoading) return state.itemCatalogLoading;
        if (state.itemCatalogLoaded && !force) return Promise.resolve(state.itemCatalog);

        const cached = storeGet(SK.itemCatalog, null);
        if (!force && cached && cached.map && cached.fetchedAt) {
            const age = Date.now() - cached.fetchedAt;
            const count = Object.keys(cached.map).length;
            if (count >= CATALOG_MIN_ITEMS && age < CATALOG_MAX_AGE_MS) {
                state.itemCatalog = cached.map;
                state.itemCatalogLoaded = true;
                state.itemCatalogError = null;
                reconcileCategoryCacheWithCatalog();
                log('item catalog loaded from cache', count);
                return Promise.resolve(state.itemCatalog);
            }
        }

        const key = getApiKey();
        if (!key) {
            warn('No Torn API key. Categories resolve via iteminfo.php per row, or expand item details.');
            state.itemCatalogLoaded = true;
            state.itemCatalogError = 'no key';
            return Promise.resolve(state.itemCatalog);
        }

        state.itemCatalogError = null;
        state.itemCatalogLoading = fetchItemCatalogFromApi(key)
            .then(map => {
                const count = Object.keys(map).length;
                if (count < CATALOG_MIN_ITEMS) {
                    throw new Error('Catalog too small (' + count + '). A Public access key is sufficient.');
                }
                state.itemCatalog = map;
                state.itemCatalogLoaded = true;
                state.itemCatalogError = null;
                storeSet(SK.itemCatalog, { map: state.itemCatalog, fetchedAt: Date.now() });
                log('item catalog fetched', count);
                clearFailedCategoryLookups();
                reconcileCategoryCacheWithCatalog();
                updateCatalogStatus();
                scheduleRefresh();
                return state.itemCatalog;
            })
            .catch(err => {
                warn('item catalog fetch failed', err);
                state.itemCatalogError = String(err.message || err);
                state.itemCatalogLoaded = true;
                updateCatalogStatus();
                scheduleRefresh();
                return state.itemCatalog;
            })
            .finally(() => {
                state.itemCatalogLoading = null;
            });

        return state.itemCatalogLoading;
    }

    function reconcileCategoryCacheWithCatalog() {
        let changed = false;
        Object.keys(state.categoryCache).forEach(key => {
            if (state.categoryCache[key] === UNKNOWN_CATEGORY && state.itemCatalog[key]) {
                delete state.categoryCache[key];
                changed = true;
            }
        });
        if (changed) saveCategoryCache();
    }

    function clearFailedCategoryLookups() {
        let changed = false;
        Object.keys(state.categoryCache).forEach(key => {
            if (state.categoryCache[key] === UNKNOWN_CATEGORY) {
                delete state.categoryCache[key];
                changed = true;
            }
        });
        Object.keys(state.categoryPending).forEach(key => delete state.categoryPending[key]);
        if (changed) saveCategoryCache();
    }

    function parseCategoryFromExpandedHtml(html) {
        if (!html) return null;
        const weaponMatch = html.match(/is a\s+([A-Za-z][A-Za-z\s-]*?)\s+Weapon/i);
        if (weaponMatch) {
            const cat = mapSubTypeToCategory(weaponMatch[1].trim());
            if (cat) return cat;
        }
        const typeMatch = html.match(/(?:Weapon\s+type|Type)\s*:?\s*<\/[^>]+>\s*<[^>]+>\s*([A-Za-z][A-Za-z\s/-]+)/i);
        if (typeMatch) {
            const cat = mapSubTypeToCategory(typeMatch[1].trim());
            if (cat) return cat;
        }
        if (/\bSMG\b/i.test(html)) return 'pistolSmg';
        if (/\b(shotgun|rifle)\s+round\b/i.test(html)) return 'rifleShotgun';
        if (/\bpistol\s+round\b/i.test(html)) return 'pistolSmg';
        if (/\bmachine gun\b/i.test(html)) return 'heavyArtillery';
        if (/\bheavy artillery\b/i.test(html)) return 'heavyArtillery';
        return parseCategoryFromInfoHtml(html);
    }

    // ---------- money ----------

    function parseMoney(str) {
        if (str == null || str === '') return null;
        let s = String(str).trim().replace(/[$,\s]/g, '').toLowerCase();
        if (!s) return null;
        const m = s.match(/^([\d.]+)([kmb])?$/i);
        if (!m) return null;
        let n = parseFloat(m[1]);
        if (!Number.isFinite(n) || n <= 0) return null;
        const suffix = m[2] || '';
        if (suffix === 'k') n *= 1000;
        else if (suffix === 'm') n *= 1000000;
        else if (suffix === 'b') n *= 1000000000;
        return Math.floor(n);
    }

    function formatPriceFull(price) {
        if (price == null || !Number.isFinite(price)) return '';
        return '$' + Math.floor(price).toLocaleString('en-US');
    }

    function formatPriceInputDisplay(price) {
        return formatPriceFull(price);
    }

    function formatTableDollar(price) {
        if (price == null || !Number.isFinite(price)) return '-';
        return formatPrice(price);
    }

    function formatHintDollar(price) {
        if (price == null || !Number.isFinite(price)) return '-';
        return formatPrice(price);
    }

    function brandFooterHtml() {
        return '<div class="' + PREFIX + '-brand">&copy; ' + BRAND_NAME + ' &middot; ' + BRAND_CREDIT + '</div>';
    }

    function formatPrice(price) {
        if (price == null || !Number.isFinite(price)) return '-';
        if (price >= 1000000000) return '$' + (price / 1000000000).toFixed(2).replace(/\.?0+$/, '') + 'b';
        if (price >= 1000000) return '$' + (price / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'm';
        if (price >= 1000) return '$' + (price / 1000).toFixed(2).replace(/\.?0+$/, '') + 'k';
        return '$' + price.toLocaleString();
    }

    function formatCompact(price) {
        if (price == null || !Number.isFinite(price)) return '-';
        if (price >= 1000000000) return (price / 1000000000).toFixed(1).replace(/\.0$/, '') + 'b';
        if (price >= 1000000) return (price / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
        if (price >= 1000) return (price / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(price);
    }

    function parseBidAmount(text) {
        if (!text) return null;
        const match = String(text).match(/\$[\d,]+/);
        const cleaned = (match ? match[0] : text).replace(/[$,\s]/g, '');
        const n = parseInt(cleaned, 10);
        return Number.isFinite(n) ? n : null;
    }

    function getBidWrapAmount(bidWrap) {
        if (!bidWrap) return null;
        return parseBidAmount(bidWrap.textContent);
    }

    function formatHintContent(mult, maxBid) {
        const bb = formatMult(mult);
        const amt = formatHintDollar(maxBid);
        return '<span class="' + PREFIX + '-hint-line">Max: ' + bb + '</span>' +
            '<span class="' + PREFIX + '-hint-line">= ' + amt + '</span>';
    }

    function formatHintPlain(mult, maxBid) {
        return 'Max: ' + formatMult(mult) + ' = ' + formatHintDollar(maxBid);
    }

    function setMoneyInputValue(input, amount) {
        if (!input) return;
        const raw = String(Math.floor(amount));
        input.value = Number(amount).toLocaleString('en-US');
        input.dataset.money = raw;
        input.setAttribute('data-money', raw);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('keyup', { bubbles: true }));
    }

    // ---------- BB table logic ----------

    function getRarityFromRow(li) {
        const plate = li.querySelector('.item-plate');
        if (!plate) return null;
        if (plate.classList.contains('glow-yellow')) return 'yellow';
        if (plate.classList.contains('glow-orange')) return 'orange';
        if (plate.classList.contains('glow-red')) return 'red';
        return null;
    }

    function getBonusCount(li) {
        return li.querySelectorAll('.iconsbonuses .bonus-attachment-icons').length || 0;
    }

    function isArmorTabActive() {
        const armorTab = document.querySelector('#types-tab-2');
        if (!armorTab) return false;
        return armorTab.getAttribute('aria-hidden') !== 'true';
    }

    function mapSubTypeToCategory(subType) {
        const s = String(subType || '').toLowerCase().trim();
        if (s === 'pistol' || s === 'smg') return 'pistolSmg';
        if (s === 'clubbing' || s === 'piercing' || s === 'slashing' || s === 'mechanical' || s === 'melee') return 'melee';
        if (s === 'rifle' || s === 'shotgun') return 'rifleShotgun';
        if (s === 'machine gun' || s === 'machinegun' || s === 'heavy artillery' || s === 'heavyartillery') return 'heavyArtillery';
        return null;
    }

    function formatMult(mult) {
        if (mult == null || !Number.isFinite(mult)) return '-';
        const n = Math.round(mult * 1000) / 1000;
        return n + ' BB';
    }

    function getRowMultiplier(rowInfo) {
        if (!rowInfo.rarity || !rowInfo.category) return null;
        return getMultiplier(rowInfo.category, rowInfo.rarity, rowInfo.bonusCount, rowInfo.isArmor);
    }

    function parseCategoryFromInfoHtml(html) {
        if (!html) return null;

        const subJson = html.match(/"sub_type"\s*:\s*"([^"]+)"/i);
        if (subJson) {
            const cat = mapSubTypeToCategory(subJson[1]);
            if (cat) return cat;
        }

        try {
            const jsonMatch = html.match(/\{[\s\S]*"sub_type"[\s\S]*\}/);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0]);
                const sub = data.sub_type || data.subType || (data.item && data.item.sub_type);
                const cat = mapSubTypeToCategory(sub);
                if (cat) return cat;
            }
        } catch (e) { /* ignore */ }

        const lower = html.toLowerCase();
        const patterns = [
            ['heavy artillery', 'heavyArtillery'],
            ['machine gun', 'heavyArtillery'],
            ['shotgun', 'rifleShotgun'],
            ['rifle', 'rifleShotgun'],
            ['pistol', 'pistolSmg'],
            ['smg', 'pistolSmg'],
            ['clubbing', 'melee'],
            ['piercing', 'melee'],
            ['slashing', 'melee'],
            ['mechanical', 'melee']
        ];
        for (const [needle, cat] of patterns) {
            if (lower.includes(needle)) return cat;
        }

        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const text = (doc.body && doc.body.textContent) || '';
            for (const [needle, cat] of patterns) {
                if (text.toLowerCase().includes(needle)) return cat;
            }
        } catch (e2) { /* ignore */ }

        return null;
    }

    function parseCategoryFromShowItemInfo(li) {
        const box = li.querySelector('.show-item-info');
        if (!box) return null;
        const html = box.innerHTML;
        if (!html || html.includes('ajax-preloader')) return null;
        return parseCategoryFromExpandedHtml(html);
    }

    function lookupCategorySync(itemId, forceArmor, li) {
        if (forceArmor) return 'armor';
        const key = String(itemId);
        if (state.itemCatalog[key]) return state.itemCatalog[key];
        const cached = getCachedCategory(itemId);
        if (cached) return cached;
        if (li) {
            const fromDom = parseCategoryFromShowItemInfo(li);
            if (fromDom) {
                state.categoryCache[key] = fromDom;
                saveCategoryCache();
                return fromDom;
            }
        }
        return null;
    }

    async function fetchCategoryHtml(itemId, armouryId) {
        const urls = [
            '/iteminfo.php?ID=' + encodeURIComponent(itemId),
            '/amarket.php?step=getiteminfo&item=' + encodeURIComponent(itemId) + '&armoury=' + encodeURIComponent(armouryId || ''),
            '/imarket.php?step=getiteminfo&item=' + encodeURIComponent(itemId) + '&armoury=' + encodeURIComponent(armouryId || '')
        ];
        for (const url of urls) {
            try {
                const html = await tornRequest(url, false);
                const cat = parseCategoryFromExpandedHtml(html);
                if (cat) {
                    log('category from', url, cat);
                    return cat;
                }
            } catch (err) {
                log('fetch error', url, err);
            }
        }
        return null;
    }

    function resolveCategory(itemId, armouryId, forceArmor, li) {
        if (forceArmor) return Promise.resolve('armor');
        const key = String(itemId);
        const sync = lookupCategorySync(itemId, forceArmor, li);
        if (sync) return Promise.resolve(sync);
        if (state.categoryCache[key] === UNKNOWN_CATEGORY && state.itemCatalog[key]) {
            delete state.categoryCache[key];
        }
        if (state.categoryPending[key]) return state.categoryPending[key];

        state.categoryPending[key] = (async () => {
            if (!state.itemCatalogLoaded) {
                await loadItemCatalog(false);
            }
            const fromCatalog = state.itemCatalog[key];
            if (fromCatalog) {
                delete state.categoryPending[key];
                return fromCatalog;
            }
            if (li) {
                const fromDom = parseCategoryFromShowItemInfo(li);
                if (fromDom) {
                    state.categoryCache[key] = fromDom;
                    saveCategoryCache();
                    delete state.categoryPending[key];
                    return fromDom;
                }
            }
            const cat = await fetchCategoryHtml(itemId, armouryId);
            state.categoryCache[key] = cat || UNKNOWN_CATEGORY;
            saveCategoryCache();
            delete state.categoryPending[key];
            log('category resolved', itemId, cat || 'unknown');
            return cat;
        })().catch(err => {
            state.categoryCache[key] = UNKNOWN_CATEGORY;
            saveCategoryCache();
            delete state.categoryPending[key];
            warn('category resolve failed', itemId, err);
            return null;
        });

        return state.categoryPending[key];
    }

    function getMultiplier(category, rarity, bonusCount, isArmor) {
        const table = state.bbTable && state.bbTable[category];
        if (!table || !rarity) return null;

        if (isArmor || category === 'armor') {
            if (rarity === 'yellow') return table.yellow;
            if (rarity === 'orange') return table.orange1;
            if (rarity === 'red') return table.red1;
            return null;
        }

        const two = bonusCount >= 2;
        if (rarity === 'yellow') return table.yellow;
        if (rarity === 'orange') return two ? table.orange2 : table.orange1;
        if (rarity === 'red') return two ? table.red2 : table.red1;
        return null;
    }

    function parseAuctionRow(li) {
        const hover = li.querySelector('.item-hover');
        const itemId = hover ? hover.getAttribute('item') : null;
        const armouryId = hover ? hover.getAttribute('armoury') : null;
        const nameEl = li.querySelector('.item-name');
        const itemName = nameEl ? nameEl.textContent.trim() : 'Item';
        const rarity = getRarityFromRow(li);
        const bonusCount = getBonusCount(li);
        const isArmor = isArmorTabActive();
        const currentBidEl = li.querySelector('.c-bid-wrap');
        const currentBid = getBidWrapAmount(currentBidEl);

        let category = isArmor ? 'armor' : (itemId ? lookupCategorySync(itemId, false, li) : null);

        return {
            li,
            itemId,
            armouryId,
            itemName,
            rarity,
            bonusCount,
            isArmor,
            category,
            currentBid
        };
    }

    function computeMaxBid(rowInfo) {
        if (!state.pricePerBB || !rowInfo.rarity || !rowInfo.category) return null;
        const mult = getMultiplier(rowInfo.category, rowInfo.rarity, rowInfo.bonusCount, rowInfo.isArmor);
        if (mult == null) return null;
        return Math.floor(state.pricePerBB * mult);
    }

    function rarityLabel(rarity, bonusCount, isArmor) {
        if (!rarity) return 'Unknown';
        if (isArmor) return rarity.charAt(0).toUpperCase() + rarity.slice(1);
        if (rarity === 'yellow') return 'Yellow';
        const n = bonusCount >= 2 ? 2 : 1;
        return rarity.charAt(0).toUpperCase() + rarity.slice(1) + ' (' + n + ' bonus' + (n > 1 ? 'es' : '') + ')';
    }

    // ---------- styles ----------

    function injectStyles() {
        if (document.getElementById(PREFIX + '-styles')) return;
        const style = document.createElement('style');
        style.id = PREFIX + '-styles';
        style.textContent = `
            .${PREFIX}-panel{
                margin:10px 0; padding:12px 14px; position:relative; z-index:2;
                background:#1f2937; border:1px solid rgba(255,255,255,.12);
                border-radius:8px; box-sizing:border-box;
            }
            .${PREFIX}-controls{
                display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; width:100%;
            }
            .${PREFIX}-field{ display:flex; flex-direction:column; gap:4px; min-width:140px; }
            .${PREFIX}-field label{ font-size:11px; color:#9ca3af; text-transform:uppercase; letter-spacing:.3px; }
            .${PREFIX}-money-wrap{
                display:flex; align-items:center; background:#111827;
                border:1px solid rgba(168,85,247,.45); border-radius:8px; overflow:hidden;
            }
            .${PREFIX}-money-wrap span.${PREFIX}-sym{
                padding:8px 10px; color:#d1d5db; background:#0f172a; font-weight:700;
            }
            .${PREFIX}-money-wrap input{
                border:none; background:#111827; color:#f3f4f6; padding:8px 10px;
                min-width:160px; font-size:13px; outline:none; font-variant-numeric:tabular-nums;
            }
            .${PREFIX}-btn{
                cursor:pointer; border:1px solid rgba(168,85,247,.5); background:#111827;
                color:#e5e7eb; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:600;
            }
            .${PREFIX}-btn:hover{ border-color:rgba(236,72,153,.55); background:#1f2937; }
            .${PREFIX}-btn.primary{
                background:linear-gradient(90deg,rgba(168,85,247,.9),rgba(236,72,153,.85));
                border-color:rgba(236,72,153,.6); color:#fff;
            }
            .${PREFIX}-preview{ width:100%; font-size:12px; color:#9ca3af; margin-top:2px; }
            .${PREFIX}-brand{
                width:100%; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,.06);
                font-size:10px; color:#6b7280; letter-spacing:.2px; text-align:right;
            }
            .${PREFIX}-modal .${PREFIX}-brand{
                margin:0; padding:10px 18px 12px; border-top:1px solid rgba(255,255,255,.06);
                text-align:center; flex-shrink:0;
            }
            ul.items-list > li .seller-wrap.${PREFIX}-seller-hint-anchor{
                position:relative; overflow:visible;
            }
            ul.items-list > li .seller-wrap > .${PREFIX}-hint-wrap{
                position:absolute; left:100%; top:50%;
                transform:translateY(-50%); margin-left:6px;
                width:5.2em; z-index:1; pointer-events:none;
            }
            ul.items-list > li .seller-wrap .${PREFIX}-desk-hint{
                display:block; width:100%;
                font-size:9px; font-weight:700; line-height:1.3;
                padding:4px 5px; border-radius:4px; text-align:center;
                white-space:normal; word-break:break-word; box-sizing:border-box;
            }
            .${PREFIX}-hint{
                display:block; font-size:9px; font-weight:700; line-height:1.3;
                padding:4px 5px; border-radius:4px; text-align:center;
                white-space:normal; word-break:break-word; width:100%; box-sizing:border-box;
            }
            .${PREFIX}-hint-line{ display:block; }
            .${PREFIX}-mob-hint{
                display:none; font-size:10px; font-weight:700; line-height:1.35;
                padding:4px 6px; margin-top:4px; border-radius:4px; text-align:left;
            }
            .${PREFIX}-mob-hint.good{ color:#6ee7b7; background:rgba(16,185,129,.15); }
            .${PREFIX}-mob-hint.warn{ color:#fbbf24; background:rgba(245,158,11,.15); }
            .${PREFIX}-mob-hint.bad{ color:#f87171; background:rgba(239,68,68,.15); }
            .${PREFIX}-mob-hint.pending{ color:#9ca3af; background:rgba(156,163,175,.12); }
            .${PREFIX}-hint.good{ color:#6ee7b7; background:rgba(16,185,129,.15); }
            .${PREFIX}-hint.warn{ color:#fbbf24; background:rgba(245,158,11,.15); }
            .${PREFIX}-hint.bad{ color:#f87171; background:rgba(239,68,68,.15); }
            .${PREFIX}-hint.pending{ color:#9ca3af; background:rgba(156,163,175,.12); }
            .${PREFIX}-bid-actions{ display:inline-flex; align-items:center; gap:8px; margin-left:8px; vertical-align:middle; }
            .${PREFIX}-icon-btn{
                width:26px; height:26px; border-radius:50%; border:1px solid rgba(168,85,247,.4);
                background:rgba(17,24,39,.8); color:#c4b5fd; cursor:pointer; font-size:14px;
                line-height:1; display:inline-flex; align-items:center; justify-content:center; padding:0;
            }
            .${PREFIX}-overlay{
                position:fixed; inset:0; z-index:100000; background:rgba(0,0,0,.85);
                display:flex; align-items:center; justify-content:center; padding:16px;
                font-family:Arial,sans-serif; pointer-events:auto;
            }
            .${PREFIX}-modal{
                background:#1f2937; border:1px solid rgba(168,85,247,.35); border-radius:12px;
                width:100%; max-height:90vh; overflow:hidden; display:flex; flex-direction:column;
                box-shadow:0 8px 32px rgba(0,0,0,.5); pointer-events:auto;
            }
            .${PREFIX}-modal-tables{ max-width:min(720px,96vw); }
            .${PREFIX}-modal-narrow{ max-width:min(380px,92vw); }
            .${PREFIX}-modal-api{ max-width:min(360px,92vw); width:100%; }
            .${PREFIX}-modal-head{
                display:flex; justify-content:space-between; align-items:center; gap:12px;
                padding:14px 18px; border-bottom:1px solid rgba(255,255,255,.08);
            }
            .${PREFIX}-modal-head .${PREFIX}-btn,
            .${PREFIX}-modal-close{
                width:auto; flex-shrink:0; white-space:nowrap; padding:6px 12px;
            }
            .${PREFIX}-modal-head h2{
                margin:0; font-size:15px; color:#f3f4f6; flex:1; min-width:0;
                line-height:1.25;
            }
            .${PREFIX}-modal-body{
                padding:16px 18px; overflow:auto; overflow-x:hidden; color:#e5e7eb; line-height:1.55;
            }
            .${PREFIX}-modal-copy{ margin:0 0 12px; line-height:1.5; font-size:13px; word-wrap:break-word; }
            .${PREFIX}-field-label{
                display:block; font-size:11px; color:#9ca3af; text-transform:uppercase;
                letter-spacing:.3px; margin-bottom:4px;
            }
            .${PREFIX}-text-input{
                width:100%; box-sizing:border-box; padding:8px 10px; margin-bottom:12px;
                border-radius:8px; border:1px solid rgba(168,85,247,.35);
                background:rgba(17,24,39,.85); color:#f3f4f6; font-size:13px;
            }
            .${PREFIX}-modal-actions{
                display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap;
            }
            .${PREFIX}-tabs{ display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px; }
            .${PREFIX}-tab{
                cursor:pointer; padding:7px 12px; border-radius:8px; font-size:12px; font-weight:700;
                border:1px solid rgba(168,85,247,.25); background:rgba(17,24,39,.5); color:#9ca3af;
            }
            .${PREFIX}-tab.active{
                color:#fff; border-color:rgba(236,72,153,.5);
                background:linear-gradient(90deg,rgba(168,85,247,.35),rgba(236,72,153,.3));
            }
            .${PREFIX}-scroll-wrap{
                position:relative; max-width:100%;
                border:1px solid rgba(255,255,255,.1); border-radius:8px;
                padding:10px 12px 6px; background:rgba(0,0,0,.12);
            }
            .${PREFIX}-scroll{
                overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch;
                margin:0; padding-bottom:16px; scrollbar-gutter:stable;
            }
            .${PREFIX}-table{
                width:100%; border-collapse:separate; border-spacing:0; font-size:12px;
                table-layout:auto; min-width:540px; margin-bottom:2px;
            }
            .${PREFIX}-table th,.${PREFIX}-table td{
                padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.08); vertical-align:middle;
            }
            .${PREFIX}-table th:first-child,.${PREFIX}-table td:first-child{
                padding-left:14px;
            }
            .${PREFIX}-table th:last-child,.${PREFIX}-table td:last-child{
                padding-right:14px;
            }
            .${PREFIX}-table tbody tr:last-child td{ border-bottom:none; }
            .${PREFIX}-table th{
                color:#e5e7eb; font-size:10px; text-transform:uppercase; letter-spacing:.35px;
                background:rgba(0,0,0,.22); font-weight:700; white-space:nowrap;
            }
            .${PREFIX}-table th.${PREFIX}-th-cat,.${PREFIX}-table td.${PREFIX}-td-cat{
                text-align:left; min-width:8.5em; max-width:11em; color:#f9fafb; font-weight:600;
                background:rgba(255,255,255,.04); line-height:1.35;
            }
            .${PREFIX}-table th.${PREFIX}-th-val,.${PREFIX}-table td.${PREFIX}-td-val{
                text-align:center; font-variant-numeric:tabular-nums;
                min-width:4.8em; white-space:nowrap; padding-left:10px; padding-right:10px;
            }
            .${PREFIX}-table td.${PREFIX}-td-val{ font-size:11px; }
            .${PREFIX}-table tbody tr:hover td{ background:rgba(168,85,247,.06); }
            .${PREFIX}-table tbody tr:hover td.${PREFIX}-td-cat{ background:rgba(168,85,247,.1); }
            .${PREFIX}-table-hint{
                margin:8px 0 0; font-size:11px; color:#9ca3af; line-height:1.45;
            }
            .${PREFIX}-cell-bb{ font-weight:700; display:block; }
            .${PREFIX}-cell-price{ display:block; font-size:11px; color:#9ca3af; margin-top:2px; }
            .${PREFIX}-table-tools{
                display:flex; gap:8px; flex-wrap:wrap; align-items:center;
                justify-content:space-between; margin-bottom:12px;
            }
            .${PREFIX}-edit-input{
                width:100%; max-width:72px; box-sizing:border-box; padding:4px 6px; border-radius:6px;
                border:1px solid rgba(168,85,247,.35); background:rgba(17,24,39,.85);
                color:#f3f4f6; font-size:12px; text-align:center;
            }
            .${PREFIX}-hint-inline{
                display:inline-block; font-size:11px; font-weight:700; padding:2px 6px;
                border-radius:4px; margin-left:6px; white-space:nowrap;
            }
            .${PREFIX}-rarity-yellow{ color:${RARITY_COLORS.yellow}; font-weight:700; }
            .${PREFIX}-rarity-orange{ color:${RARITY_COLORS.orange}; font-weight:700; }
            .${PREFIX}-rarity-red{ color:${RARITY_COLORS.red}; font-weight:700; }
            .${PREFIX}-breakdown{
                display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px 20px; align-items:baseline;
            }
            .${PREFIX}-breakdown .k{ color:#9ca3af; font-size:13px; }
            .${PREFIX}-breakdown .v{
                font-weight:700; text-align:right; font-variant-numeric:tabular-nums;
                font-size:13px; color:#f3f4f6; word-break:break-word;
            }
            .${PREFIX}-note{ margin-top:12px; font-size:12px; color:#9ca3af; line-height:1.5; }
            @media (max-width:784px){
                ul.items-list > li .seller-wrap > .${PREFIX}-hint-wrap{ display:none !important; }
                ul.items-list > li > .${PREFIX}-hint-wrap{ display:none !important; }
                .${PREFIX}-mob-hint{ display:block; }
            }
            @media (min-width:785px){
                ul.items-list > li .${PREFIX}-mob-hint{ display:none !important; }
            }
            @media (max-width:900px){
                .${PREFIX}-controls .${PREFIX}-btn{ width:100%; text-align:center; }
                .${PREFIX}-controls{ flex-direction:column; align-items:stretch; }
                .${PREFIX}-field,.${PREFIX}-money-wrap input{ width:100%; min-width:0; }
                .${PREFIX}-bid-actions{ display:flex; flex-wrap:wrap; margin:8px 0 0; }
                .${PREFIX}-overlay{ padding:12px; align-items:center; justify-content:center; }
                .${PREFIX}-modal{ max-height:88vh; border-radius:12px; }
                .${PREFIX}-modal-tables{ max-width:100%; }
                .${PREFIX}-table{ min-width:480px; font-size:11px; }
                .${PREFIX}-table th.${PREFIX}-th-cat,.${PREFIX}-table td.${PREFIX}-td-cat{
                    min-width:7em; max-width:8.5em; font-size:10px;
                }
                .${PREFIX}-table-tools{ flex-direction:column; align-items:stretch; }
                .${PREFIX}-table-tools .${PREFIX}-tabs{ width:100%; }
                .${PREFIX}-table-tools .${PREFIX}-btn{ width:100%; }
            }
        `;
        document.head.appendChild(style);
    }

    // ---------- modals ----------

    function closeModal() {
        const el = document.getElementById(PREFIX + '-overlay');
        if (el) el.remove();
        document.body.style.overflow = '';
    }

    function openModal(title, bodyHtml, modalClass) {
        closeModal();
        const overlay = document.createElement('div');
        overlay.id = PREFIX + '-overlay';
        overlay.className = PREFIX + '-overlay';
        const modalCls = PREFIX + '-modal' + (modalClass ? ' ' + modalClass : ' ' + PREFIX + '-modal-tables');
        overlay.innerHTML =
            '<div class="' + modalCls + '" role="dialog" aria-modal="true">' +
                '<div class="' + PREFIX + '-modal-head">' +
                    '<h2>' + title + '</h2>' +
                    '<button type="button" class="' + PREFIX + '-btn ' + PREFIX + '-modal-close" data-action="close">Close</button>' +
                '</div>' +
                '<div class="' + PREFIX + '-modal-body">' + bodyHtml + '</div>' +
                brandFooterHtml() +
            '</div>';

        overlay.addEventListener('click', e => {
            if (e.target === overlay) closeModal();
        });

        const modal = overlay.querySelector('.' + PREFIX + '-modal');
        modal.addEventListener('click', e => e.stopPropagation());

        const closeBtn = overlay.querySelector('[data-action="close"]');
        if (closeBtn) {
            closeBtn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
            });
        }

        document.body.style.overflow = 'hidden';
        document.body.appendChild(overlay);
        log('modal opened', title);
        return overlay;
    }

    function formatBbCellValue(val) {
        if (val == null || !Number.isFinite(val)) return '-';
        const n = Math.round(val * 1000) / 1000;
        return String(n);
    }

    function buildTableHtml(mode, section, editing) {
        const isWeapons = section === 'weapons';
        const cols = isWeapons ? WEAPON_COLS : ARMOR_COLS;
        const rows = isWeapons ? WEAPON_ROWS : ['armor'];
        const headers = '<tr><th class="' + PREFIX + '-th-cat">Category</th>' +
            cols.map(c => '<th class="' + PREFIX + '-th-val ' + PREFIX + '-rarity-' + c.rarity + '">' + c.label + '</th>').join('') + '</tr>';

        const body = rows.map(catKey => {
            const cells = cols.map(col => {
                const rarityCls = PREFIX + '-rarity-' + col.rarity;
                const dataKey = 'data-cat="' + catKey + '" data-col="' + col.key + '"';
                if (editing) {
                    let raw;
                    if (mode === 'bb') {
                        raw = formatBbCellValue(getBbCell(catKey, col.key));
                    } else {
                        const d = getDollarCell(catKey, col.key);
                        raw = d != null ? formatPriceFull(d) : '';
                    }
                    return '<td class="' + PREFIX + '-td-val ' + rarityCls + '"><input type="text" class="' + PREFIX + '-edit-input" ' +
                        dataKey + ' value="' + raw + '"></td>';
                }
                if (mode === 'bb') {
                    return '<td class="' + PREFIX + '-td-val ' + rarityCls + '">' + formatBbCellValue(getBbCell(catKey, col.key)) + '</td>';
                }
                const dollars = getDollarCell(catKey, col.key);
                const full = dollars != null ? formatPriceFull(dollars) : '';
                const compact = dollars != null ? formatTableDollar(dollars) : '-';
                return '<td class="' + PREFIX + '-td-val ' + rarityCls + '" title="' + full + '">' + compact + '</td>';
            }).join('');
            const label = isWeapons ? CATEGORY_LABELS_SHORT[catKey] : 'Armor';
            const labelTitle = isWeapons ? CATEGORY_LABELS[catKey] : 'Armor';
            return '<tr><td class="' + PREFIX + '-td-cat" title="' + labelTitle + '">' + label + '</td>' + cells + '</tr>';
        }).join('');

        return '<div class="' + PREFIX + '-scroll-wrap"><div class="' + PREFIX + '-scroll"><table class="' + PREFIX + '-table">' +
            headers + body + '</table></div></div>';
    }

    function openTablesModal(e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        const overlay = openModal('BB Tables', '<div id="' + PREFIX + '-tables-host"></div>', PREFIX + '-modal-tables');
        const host = overlay.querySelector('#' + PREFIX + '-tables-host');
        let mainTab = 'bb';
        let sectionTab = 'weapons';
        let editing = false;

        function saveEdits() {
            host.querySelectorAll('.' + PREFIX + '-edit-input').forEach(input => {
                const cat = input.getAttribute('data-cat');
                const col = input.getAttribute('data-col');
                if (!cat || !col) return;
                if (mainTab === 'bb') {
                    const val = parseFloat(String(input.value).replace(/,/g, ''));
                    if (!Number.isFinite(val)) return;
                    if (!state.bbTable[cat]) state.bbTable[cat] = {};
                    state.bbTable[cat][col] = val;
                } else {
                    const val = parseMoney(input.value);
                    if (!val) return;
                    if (!state.dollarTable[cat]) state.dollarTable[cat] = {};
                    state.dollarTable[cat][col] = val;
                }
            });
            if (mainTab === 'bb') saveBbTable();
            else saveDollarTable();
            editing = false;
            scheduleRefresh();
        }

        function resetCurrentTab() {
            if (mainTab === 'bb') {
                state.bbTable = cloneDefaultBbTable();
                saveBbTable();
            } else {
                state.dollarTable = {};
                saveDollarTable();
            }
            editing = false;
            scheduleRefresh();
        }

        function render() {
            const note = mainTab === 'bb'
                ? '<p class="' + PREFIX + '-note">BB multipliers used for max bid = price per BB x BB. Edit to update your buy table.</p>'
                : (state.pricePerBB
                    ? '<p class="' + PREFIX + '-note">Max bid dollars at ' + formatPriceFull(state.pricePerBB) + ' per BB. Values shown compact; tap/hover a cell for the full amount.</p>'
                    : '<p class="' + PREFIX + '-note">Set price per BB above to calculate dollar max bids from the BB table.</p>');
            const scrollHint = '<p class="' + PREFIX + '-table-hint">Swipe sideways on narrow screens to see all columns.</p>';

            const toolBtns = editing
                ? '<button type="button" class="' + PREFIX + '-btn primary" data-action="save">Save</button>' +
                  '<button type="button" class="' + PREFIX + '-btn" data-action="cancel">Cancel</button>' +
                  '<button type="button" class="' + PREFIX + '-btn" data-action="reset">Reset defaults</button>'
                : '<button type="button" class="' + PREFIX + '-btn" data-action="edit">Edit</button>';

            host.innerHTML =
                '<div class="' + PREFIX + '-tabs">' +
                    '<button type="button" class="' + PREFIX + '-tab' + (mainTab === 'bb' ? ' active' : '') + '" data-main="bb">BB Multipliers</button>' +
                    '<button type="button" class="' + PREFIX + '-tab' + (mainTab === 'dollar' ? ' active' : '') + '" data-main="dollar">Max Bid ($)</button>' +
                '</div>' +
                '<div class="' + PREFIX + '-table-tools">' +
                    '<div class="' + PREFIX + '-tabs" style="margin:0">' +
                        '<button type="button" class="' + PREFIX + '-tab' + (sectionTab === 'weapons' ? ' active' : '') + '" data-section="weapons">Weapons</button>' +
                        '<button type="button" class="' + PREFIX + '-tab' + (sectionTab === 'armor' ? ' active' : '') + '" data-section="armor">Armor</button>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap">' + toolBtns + '</div>' +
                '</div>' +
                buildTableHtml(mainTab, sectionTab, editing) +
                scrollHint +
                note;

            host.querySelectorAll('[data-main]').forEach(btn => {
                btn.addEventListener('click', ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (editing) return;
                    mainTab = btn.getAttribute('data-main');
                    render();
                });
            });
            host.querySelectorAll('[data-section]').forEach(btn => {
                btn.addEventListener('click', ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (editing) return;
                    sectionTab = btn.getAttribute('data-section');
                    render();
                });
            });

            const editBtn = host.querySelector('[data-action="edit"]');
            if (editBtn) {
                editBtn.addEventListener('click', ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    editing = true;
                    render();
                });
            }
            const saveBtn = host.querySelector('[data-action="save"]');
            if (saveBtn) {
                saveBtn.addEventListener('click', ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    saveEdits();
                    render();
                });
            }
            const cancelBtn = host.querySelector('[data-action="cancel"]');
            if (cancelBtn) {
                cancelBtn.addEventListener('click', ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    editing = false;
                    render();
                });
            }
            const resetBtn = host.querySelector('[data-action="reset"]');
            if (resetBtn) {
                resetBtn.addEventListener('click', ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (confirm('Reset this tab to default values?')) {
                        resetCurrentTab();
                        render();
                    }
                });
            }
        }
        render();
    }

    function openBreakdownModal(rowInfo, maxBid, mult) {
        const lines = [
            ['Item', rowInfo.itemName],
            ['Category', rowInfo.category ? CATEGORY_LABELS[rowInfo.category] : 'Unknown'],
            ['Rarity', rarityLabel(rowInfo.rarity, rowInfo.bonusCount, rowInfo.isArmor)],
            ['BB multiplier', mult != null ? String(Math.round(mult * 1000) / 1000) : '-'],
            ['Price per BB', state.pricePerBB ? formatPriceFull(state.pricePerBB) : '-'],
            ['Max bid', maxBid != null ? formatPriceFull(maxBid) : '-']
        ];
        if (rowInfo.currentBid != null && maxBid != null) {
            lines.push(['Current bid', formatPriceFull(rowInfo.currentBid)]);
            lines.push(['Vs target', rowInfo.currentBid <= maxBid ? 'At or below target' : 'Above target']);
        }
        const body =
            '<div class="' + PREFIX + '-breakdown">' +
            lines.map(([k, v]) =>
                '<span class="k">' + k + '</span><span class="v">' + v + '</span>'
            ).join('') +
            '</div>' +
            '<p class="' + PREFIX + '-note">This is your max willingness at your BB rate, not the 1% minimum over the current bid.</p>';

        openModal('Bid breakdown', body, PREFIX + '-modal-narrow');
    }

    // ---------- row UI ----------

    function hintClassForRow(rowInfo, maxBid) {
        let cls = PREFIX + '-hint good';
        if (rowInfo.currentBid != null && maxBid != null) {
            if (rowInfo.currentBid > maxBid) cls = PREFIX + '-hint bad';
            else if (rowInfo.currentBid > maxBid * 0.9) cls = PREFIX + '-hint warn';
        }
        return cls;
    }

    function getOrCreateDesktopHint(li) {
        const sellerWrap = li.querySelector('.seller-wrap');
        if (!sellerWrap) return null;

        sellerWrap.classList.add(PREFIX + '-seller-hint-anchor');
        let wrap = sellerWrap.querySelector('.' + PREFIX + '-hint-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = PREFIX + '-hint-wrap';
            sellerWrap.appendChild(wrap);
        }

        let hint = wrap.querySelector('.' + PREFIX + '-desk-hint');
        if (!hint) {
            hint = document.createElement('div');
            hint.className = PREFIX + '-desk-hint ' + PREFIX + '-hint pending';
            wrap.appendChild(hint);
        }
        return hint;
    }

    function removeRowHint(li) {
        li.querySelectorAll(':scope > .' + PREFIX + '-hint-wrap').forEach(n => n.remove());
        const sellerWrap = li.querySelector('.seller-wrap');
        if (sellerWrap) {
            sellerWrap.querySelectorAll('.' + PREFIX + '-hint-wrap').forEach(n => n.remove());
            sellerWrap.classList.remove(PREFIX + '-seller-hint-anchor');
        }
        const bidWrap = li.querySelector('.c-bid-wrap');
        if (bidWrap) {
            bidWrap.querySelectorAll('.' + PREFIX + '-desk-hint').forEach(n => n.remove());
            bidWrap.classList.remove(PREFIX + '-bid-anchor');
        }
        const bidsWrap = li.querySelector('.bids-wrap');
        if (bidsWrap) {
            bidsWrap.querySelectorAll('.' + PREFIX + '-desk-hint').forEach(n => n.remove());
            bidsWrap.classList.remove(PREFIX + '-bids-stack');
        }
        li.querySelectorAll(':scope > .' + PREFIX + '-desk-hint').forEach(n => n.remove());
        const mobHint = li.querySelector('.' + PREFIX + '-mob-hint');
        if (mobHint) mobHint.remove();
    }

    function updateRowHint(li, rowInfo, maxBid, mult) {
        const mobBid = li.querySelector('.top-bid-mob-wrap');

        if (!state.pricePerBB) {
            removeRowHint(li);
            return;
        }

        if (!rowInfo.category) {
            const hint = getOrCreateDesktopHint(li);
            if (!hint) return;
            const pendingHtml = '<span class="' + PREFIX + '-hint-line">Max: loading...</span>';
            const pendingCls = PREFIX + '-desk-hint ' + PREFIX + '-hint pending';
            if (hint.innerHTML !== pendingHtml || hint.className !== pendingCls) {
                hint.innerHTML = pendingHtml;
                hint.className = pendingCls;
            }
            return;
        }

        if (maxBid == null || mult == null) {
            removeRowHint(li);
            return;
        }

        const hintHtml = formatHintContent(mult, maxBid);
        const cls = PREFIX + '-desk-hint ' + hintClassForRow(rowInfo, maxBid);

        const hint = getOrCreateDesktopHint(li);
        if (hint && (hint.innerHTML !== hintHtml || hint.className !== cls)) {
            hint.innerHTML = hintHtml;
            hint.className = cls;
        }

        if (mobBid) {
            const mobText = formatHintPlain(mult, maxBid);
            const mobCls = PREFIX + '-mob-hint ' + hintClassForRow(rowInfo, maxBid).replace(PREFIX + '-hint ', '');
            let mh = li.querySelector('.' + PREFIX + '-mob-hint');
            if (!mh) {
                mh = document.createElement('div');
                mobBid.insertAdjacentElement('afterend', mh);
            }
            if (mh.textContent !== mobText || mh.className !== mobCls) {
                mh.textContent = mobText;
                mh.className = mobCls;
            }
        }

        li.dataset.bbMultiplier = String(mult);
        li.dataset.bbMaxBid = String(maxBid);
    }

    function cleanupLegacyBidWrap(li) {
        const bidWrap = li.querySelector('.c-bid-wrap');
        if (bidWrap) {
            const inner = bidWrap.querySelector('.' + PREFIX + '-bid-inner');
            if (inner) {
                const amountEl = inner.querySelector('.' + PREFIX + '-bid-amount');
                bidWrap.textContent = amountEl ? amountEl.textContent.trim() : inner.textContent.trim();
            }
            bidWrap.querySelectorAll('.' + PREFIX + '-row-hint, .' + PREFIX + '-desk-hint').forEach(n => n.remove());
            bidWrap.classList.remove(PREFIX + '-bid-stack', PREFIX + '-bid-anchor');
        }
        const bidsWrap = li.querySelector('.bids-wrap');
        if (bidsWrap) {
            bidsWrap.querySelectorAll('.' + PREFIX + '-desk-hint').forEach(n => n.remove());
            bidsWrap.classList.remove(PREFIX + '-bids-stack');
        }
        li.querySelectorAll(':scope > .' + PREFIX + '-hint-wrap').forEach(n => n.remove());
    }

    function pauseListObservers() {
        state.observersPaused = true;
    }

    function resumeListObservers() {
        state.observersPaused = false;
    }

    function cleanupLegacyControls() {
        const legacy = document.querySelector('.add-listing.cont-gray .cont.big-select-menu-wrap #' + PREFIX + '-controls');
        if (legacy) legacy.remove();
    }

    async function refreshRow(li) {
        if (!li.id || li.classList.contains('clear')) return;
        if (!li.dataset.bbLegacyCleaned) {
            cleanupLegacyBidWrap(li);
            li.dataset.bbLegacyCleaned = '1';
        }
        const rowInfo = parseAuctionRow(li);

        if (!rowInfo.isArmor && rowInfo.itemId && !rowInfo.category) {
            updateRowHint(li, rowInfo, null, null);
            const cat = await resolveCategory(rowInfo.itemId, rowInfo.armouryId, false, li);
            if (!li.isConnected) return;
            rowInfo.category = cat;
            const mult = getRowMultiplier(rowInfo);
            const maxBid = mult != null ? Math.floor(state.pricePerBB * mult) : null;
            updateRowHint(li, rowInfo, maxBid, mult);
            return;
        }

        const mult = getRowMultiplier(rowInfo);
        const maxBid = mult != null && state.pricePerBB ? Math.floor(state.pricePerBB * mult) : null;
        updateRowHint(li, rowInfo, maxBid, mult);
    }

    async function refreshAllRows() {
        if (state.refreshInFlight) return;
        state.refreshInFlight = true;
        pauseListObservers();
        try {
            const rows = Array.from(document.querySelectorAll('ul.items-list > li[id]'));
            log('refresh rows', rows.length);
            await Promise.all(rows.map(li => refreshRow(li)));
            scheduleBidPanelScan();
        } finally {
            state.refreshInFlight = false;
            resumeListObservers();
        }
    }

    function scheduleRefresh(delayMs) {
        const delay = delayMs != null ? delayMs : (state.isPDA ? 450 : 200);
        if (state.refreshTimer) clearTimeout(state.refreshTimer);
        state.refreshTimer = setTimeout(() => {
            state.refreshTimer = null;
            refreshAllRows();
        }, delay);
    }

    function scheduleTabRefresh() {
        if (state.tabRefreshTimer) clearTimeout(state.tabRefreshTimer);
        pauseListObservers();
        state.tabRefreshTimer = setTimeout(() => {
            state.tabRefreshTimer = null;
            refreshAllRows();
        }, state.isPDA ? 550 : 350);
    }

    // ---------- bid panel ----------

    function injectBidPanelActions(confirmEl) {
        if (!confirmEl || confirmEl.querySelector('.' + PREFIX + '-bid-actions')) return;
        if (confirmEl.querySelector('.ajax-preloader')) return;

        const cancel = confirmEl.querySelector('.cancel');
        if (!cancel) return;

        const li = confirmEl.closest('li');
        if (!li) return;

        const actions = document.createElement('span');
        actions.className = PREFIX + '-bid-actions';

        const setBtn = document.createElement('button');
        setBtn.type = 'button';
        setBtn.className = PREFIX + '-btn primary';
        setBtn.textContent = 'Set max bid';

        const helpBtn = document.createElement('button');
        helpBtn.type = 'button';
        helpBtn.className = PREFIX + '-icon-btn';
        helpBtn.title = 'Bid breakdown';
        helpBtn.textContent = '?';

        actions.appendChild(setBtn);
        actions.appendChild(helpBtn);
        cancel.parentNode.insertBefore(actions, cancel.nextSibling);
        log('bid panel actions injected', li.id);

        async function runSetMax(e) {
            e.preventDefault();
            e.stopPropagation();
            const rowInfo = parseAuctionRow(li);
            if (!rowInfo.isArmor && rowInfo.itemId && !rowInfo.category) {
                rowInfo.category = await resolveCategory(rowInfo.itemId, rowInfo.armouryId, false, li);
            }

            let maxBid = null;
            const cached = li.dataset.bbMaxBid;
            if (cached && /^\d+$/.test(cached)) {
                maxBid = parseInt(cached, 10);
            }
            if (!maxBid) {
                const mult = getRowMultiplier(rowInfo);
                if (mult != null && state.pricePerBB) {
                    maxBid = Math.floor(state.pricePerBB * mult);
                }
            }

            if (!state.pricePerBB) {
                alert('Set price per BB in the bar above first.');
                return;
            }
            if (!maxBid) {
                const mult = getRowMultiplier(rowInfo);
                alert('Could not compute max bid.\n' +
                    'Category: ' + (rowInfo.category ? CATEGORY_LABELS[rowInfo.category] : 'unknown') + '\n' +
                    'Rarity: ' + (rowInfo.rarity || 'unknown') + '\n' +
                    'BB multiplier: ' + (mult != null ? formatMult(mult) : 'unknown') + '\n' +
                    'Open Tables to look up BB manually if type detection fails.');
                return;
            }

            const inputs = confirmEl.querySelectorAll('input.input-money');
            inputs.forEach(inp => setMoneyInputValue(inp, maxBid));

            const bidBtn = confirmEl.querySelector('button.torn-btn');
            if (bidBtn) {
                bidBtn.disabled = false;
                bidBtn.classList.remove('disabled');
            }
            log('set max bid', maxBid);
        }

        setBtn.addEventListener('click', runSetMax);
        helpBtn.addEventListener('click', async e => {
            e.preventDefault();
            e.stopPropagation();
            const rowInfo = parseAuctionRow(li);
            if (!rowInfo.isArmor && rowInfo.itemId && !rowInfo.category) {
                rowInfo.category = await resolveCategory(rowInfo.itemId, rowInfo.armouryId, false, li);
            }
            const mult = getRowMultiplier(rowInfo);
            const maxBid = mult != null && state.pricePerBB ? Math.floor(state.pricePerBB * mult) : null;
            openBreakdownModal(rowInfo, maxBid, mult);
        });
    }

    function isBidConfirmOpen(confirmEl) {
        if (!confirmEl) return false;
        const li = confirmEl.closest('li');
        if (li && li.classList.contains('active')) return true;
        const display = confirmEl.style.display;
        if (display && display !== 'none') return true;
        return confirmEl.offsetHeight > 0;
    }

    function scanBidPanels() {
        document.querySelectorAll('ul.items-list > li .confirm.p10').forEach(confirmEl => {
            if (!isBidConfirmOpen(confirmEl)) return;
            injectBidPanelActions(confirmEl);
        });
    }

    function scheduleBidPanelScan() {
        if (state.bidScanTimer) clearTimeout(state.bidScanTimer);
        state.bidScanTimer = setTimeout(() => {
            state.bidScanTimer = null;
            scanBidPanels();
        }, 60);
    }

    function observeBidPanels() {
        const root = document.querySelector('.items-list-wrap') || document.querySelector('ul.items-list');
        if (!root || state.bidPanelBound) return;
        state.bidPanelBound = true;

        root.addEventListener('click', e => {
            if (e.target.closest('.bid-icon, .bid-wrap, .bid.btn, .bid-wrap .torn-btn')) {
                scheduleBidPanelScan();
                setTimeout(scheduleBidPanelScan, 120);
                setTimeout(scheduleBidPanelScan, 350);
            }
        }, true);

        if (state.bidPanelObserver) return;
        state.bidPanelObserver = new MutationObserver(mutations => {
            if (state.observersPaused) return;
            for (const m of mutations) {
                if (shouldIgnoreMutation(m)) continue;
                const target = m.target;
                if (!(target instanceof Element)) continue;
                if (m.type === 'attributes' && target.classList.contains('confirm')) {
                    scheduleBidPanelScan();
                    return;
                }
                if (m.type === 'attributes' && target.tagName === 'LI' && m.attributeName === 'class') {
                    scheduleBidPanelScan();
                    return;
                }
                if (m.type === 'childList' && (
                    target.classList.contains('confirm') ||
                    target.closest('.confirm') ||
                    (m.addedNodes.length && Array.from(m.addedNodes).some(n =>
                        n instanceof Element && (n.classList.contains('confirm') || n.querySelector('.confirm'))
                    ))
                )) {
                    scheduleBidPanelScan();
                    return;
                }
            }
        });
        state.bidPanelObserver.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class']
        });
        log('bid panel observer attached');
    }

    // ---------- top bar ----------

    function updateCatalogStatus() {
        const el = document.getElementById(PREFIX + '-catalog-status');
        if (!el) return;
        const n = Object.keys(state.itemCatalog).length;
        if (state.itemCatalogLoading) {
            el.textContent = 'Loading item catalog...';
            el.style.color = '#9ca3af';
        } else if (n >= CATALOG_MIN_ITEMS) {
            el.textContent = 'Item catalog: ' + n + ' weapons/armor (refreshed weekly, 2 API calls max)';
            el.style.color = '#6ee7b7';
        } else if (state.itemCatalogError && state.itemCatalogError !== 'no key') {
            el.textContent = 'Catalog API failed: ' + state.itemCatalogError + ' — using iteminfo.php per row instead';
            el.style.color = '#fbbf24';
        } else if (!getApiKey()) {
            el.textContent = state.isPDA
                ? 'Set API key in Torn PDA script settings (Public access is enough)'
                : 'No API key — categories load per row via iteminfo.php (item ID on each row)';
            el.style.color = '#9ca3af';
        } else {
            el.textContent = 'Catalog empty — categories load per row via iteminfo.php';
            el.style.color = '#9ca3af';
        }
    }

    function updatePreview() {
        const el = document.getElementById(PREFIX + '-preview');
        if (!el) return;
        if (!state.pricePerBB) {
            el.textContent = 'Enter price per BB to see max bid examples.';
            return;
        }
        const exMult = state.bbTable.pistolSmg.yellow;
        const ex = Math.floor(state.pricePerBB * exMult);
        el.textContent = 'Example: yellow pistol/SMG = ' + formatMult(exMult) + ' = ' + formatPrice(ex);
    }

    function onPriceChange(raw, fromInput) {
        const parsed = parseMoney(raw);
        if (parsed) {
            state.pricePerBB = parsed;
            storeSet(SK.pricePerBB, parsed);
            log('price per BB set', parsed);
        } else if (raw === '' || raw == null) {
            state.pricePerBB = null;
        }
        updatePreview();
        scheduleRefresh();
    }

    function findTopBarAnchor() {
        return document.getElementById('auction-house-tabs') ||
            document.querySelector('hr.delimiter-999');
    }

    function injectTopBar() {
        cleanupLegacyControls();
        if (document.getElementById(PREFIX + '-panel')) return false;
        const anchor = findTopBarAnchor();
        if (!anchor) return false;

        const saved = storeGet(SK.pricePerBB, null);
        if (saved) state.pricePerBB = saved;

        const panel = document.createElement('div');
        panel.id = PREFIX + '-panel';
        panel.className = PREFIX + '-panel' + (state.isPDA ? ' ' + PREFIX + '-pda' : '');
        const apiBtnHtml = state.isPDA ? '' :
            '<button type="button" class="' + PREFIX + '-btn" id="' + PREFIX + '-api-btn" title="Set Torn API key for weapon category detection">API Key</button>';
        panel.innerHTML =
            '<div id="' + PREFIX + '-controls" class="' + PREFIX + '-controls">' +
                '<div class="' + PREFIX + '-field">' +
                    '<label for="' + PREFIX + '-price">Price per BB</label>' +
                    '<div class="' + PREFIX + '-money-wrap">' +
                        '<span class="' + PREFIX + '-sym">$</span>' +
                        '<input id="' + PREFIX + '-price" type="text" placeholder="5.7m" autocomplete="off" spellcheck="false">' +
                    '</div>' +
                '</div>' +
                '<button type="button" class="' + PREFIX + '-btn" id="' + PREFIX + '-tables-btn">Tables</button>' +
                apiBtnHtml +
                '<div class="' + PREFIX + '-preview" id="' + PREFIX + '-preview"></div>' +
                '<div class="' + PREFIX + '-preview" id="' + PREFIX + '-catalog-status"></div>' +
                brandFooterHtml() +
            '</div>';

        anchor.insertAdjacentElement('beforebegin', panel);

        const controls = document.getElementById(PREFIX + '-controls');
        const input = document.getElementById(PREFIX + '-price');
        if (state.pricePerBB) {
            input.value = formatPriceInputDisplay(state.pricePerBB);
        }

        controls.addEventListener('click', e => e.stopPropagation());
        controls.addEventListener('mousedown', e => e.stopPropagation());

        input.addEventListener('input', () => onPriceChange(input.value, true));
        input.addEventListener('focus', () => {
            if (state.pricePerBB) input.value = formatCompact(state.pricePerBB);
            input.select();
        });
        input.addEventListener('blur', () => {
            const parsed = parseMoney(input.value);
            if (parsed) {
                state.pricePerBB = parsed;
                storeSet(SK.pricePerBB, parsed);
                input.value = formatPriceInputDisplay(parsed);
            } else if (state.pricePerBB) {
                input.value = formatPriceInputDisplay(state.pricePerBB);
            }
        });
        input.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                const parsed = parseMoney(input.value);
                if (parsed) {
                    state.pricePerBB = parsed;
                    storeSet(SK.pricePerBB, parsed);
                    input.value = formatPriceInputDisplay(parsed);
                }
                input.blur();
            }
        });

        document.getElementById(PREFIX + '-tables-btn').addEventListener('click', openTablesModal);
        const apiBtn = document.getElementById(PREFIX + '-api-btn');
        if (apiBtn) {
            apiBtn.addEventListener('click', async e => {
                e.preventDefault();
                e.stopPropagation();
                const key = await promptForApiKeyModal();
                if (key) {
                    clearFailedCategoryLookups();
                    state.itemCatalogLoaded = false;
                    state.itemCatalog = {};
                    state.itemCatalogLoading = null;
                    state.itemCatalogError = null;
                    await loadItemCatalog(true);
                    updateCatalogStatus();
                    scheduleRefresh();
                }
            });
        }
        updatePreview();
        updateCatalogStatus();

        const tabs = document.querySelector('#auction-house-tabs');
        if (tabs) {
            tabs.addEventListener('click', () => scheduleTabRefresh());
        }

        log('top bar injected');
        return true;
    }

    function ensureTopBar() {
        if (injectTopBar()) return;
        if (state.topBarObserver) return;
        state.topBarObserver = new MutationObserver(() => {
            if (injectTopBar()) {
                state.topBarObserver.disconnect();
                state.topBarObserver = null;
            }
        });
        state.topBarObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ---------- observers ----------

    function shouldIgnoreMutation(mutation) {
        const target = mutation.target;
        if (!(target instanceof Element)) return true;
        if (target.closest('#' + PREFIX + '-overlay')) return true;
        if (target.closest('#' + PREFIX + '-panel')) return true;
        if (target.closest('#' + PREFIX + '-controls')) return true;
        if (target.classList && (
            target.classList.contains(PREFIX + '-hint') ||
            target.classList.contains(PREFIX + '-desk-hint') ||
            target.classList.contains(PREFIX + '-mob-hint') ||
            target.classList.contains(PREFIX + '-bid-actions')
        )) return true;
        if (target.closest('.' + PREFIX + '-hint-wrap')) return true;
        if (target.closest('.' + PREFIX + '-hint') || target.closest('.' + PREFIX + '-desk-hint') || target.closest('.' + PREFIX + '-bid-actions')) return true;
        return false;
    }

    function observeAuctionList() {
        const root = document.querySelector('.items-list-wrap') || document.querySelector('ul.items-list');
        if (!root || state.listObserver) return;

        state.listObserver = new MutationObserver(mutations => {
            if (state.observersPaused) return;
            let relevant = false;
            for (const m of mutations) {
                if (shouldIgnoreMutation(m)) continue;
                if (m.type === 'childList') {
                    relevant = true;
                    break;
                }
            }
            if (relevant) scheduleRefresh();
        });
        state.listObserver.observe(root, { childList: true, subtree: true });
        log('list observer attached');
    }

    function observeItemInfoExpansion() {
        const root = document.querySelector('.items-list-wrap') || document.querySelector('ul.items-list');
        if (!root || state.infoObserver) return;

        state.infoObserver = new MutationObserver(mutations => {
            if (state.observersPaused) return;
            let relevant = false;
            for (const m of mutations) {
                if (shouldIgnoreMutation(m)) continue;
                const target = m.target;
                if (!(target instanceof Element)) continue;
                const info = target.classList && target.classList.contains('show-item-info')
                    ? target
                    : target.closest && target.closest('.show-item-info');
                if (!info) continue;
                if (m.type === 'childList' || m.type === 'characterData') {
                    relevant = true;
                    break;
                }
            }
            if (relevant) scheduleRefresh();
        });
        state.infoObserver.observe(root, { childList: true, subtree: true, characterData: true });
        log('item info observer attached');
    }

    // ---------- init ----------

    function init() {
        if (!/amarket\.php/i.test(window.location.pathname)) return;

        state.debug = !!storeGet(SK.debug, true);
        state.bbTable = loadBbTableFromStorage();
        state.dollarTable = loadDollarTableFromStorage();
        injectStyles();
        loadCategoryCache();
        log('init v1.4.0', { debug: state.debug, cachedCategories: Object.keys(state.categoryCache).length });

        const boot = async () => {
            state.isPDA = await checkTornPDA();
            log('environment', { isPDA: state.isPDA, hasApiKey: !!getApiKey() });
            ensureTopBar();
            observeAuctionList();
            observeItemInfoExpansion();
            observeBidPanels();
            await ensureApiKey();
            await loadItemCatalog(false);
            updateCatalogStatus();
            scheduleRefresh();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot);
        } else {
            boot();
        }

        window.addEventListener('hashchange', () => scheduleRefresh());

        window.BBAuctionCalc = {
            setDebug(v) { state.debug = !!v; storeSet(SK.debug, state.debug); },
            setApiKey(key) {
                saveApiKey(key);
                clearFailedCategoryLookups();
                state.itemCatalogLoaded = false;
                state.itemCatalog = {};
                state.itemCatalogLoading = null;
                state.itemCatalogError = null;
                return loadItemCatalog(true).then(map => {
                    updateCatalogStatus();
                    scheduleRefresh();
                    return map;
                });
            },
            promptApiKey: promptForApiKeyModal,
            reloadCatalog() {
                clearFailedCategoryLookups();
                return loadItemCatalog(true).then(map => {
                    updateCatalogStatus();
                    scheduleRefresh();
                    return map;
                });
            },
            testCatalog: async () => {
                const key = getApiKey();
                console.log('[BB Auction] testCatalog', { hasKey: !!key, keyLen: key ? key.length : 0 });
                try {
                    const map = await fetchItemCatalogFromApi(key);
                    console.log('[BB Auction] catalog size', Object.keys(map).length);
                    console.log('[BB Auction] sample', { 111: map['111'], 177: map['177'], 399: map['399'] });
                    return map;
                } catch (e) {
                    console.error('[BB Auction] testCatalog failed', e);
                    throw e;
                }
            },
            testItemInfo: async itemId => {
                const cat = await fetchCategoryHtml(itemId, '');
                console.log('[BB Auction] iteminfo category', itemId, cat);
                return cat;
            },
            refresh: scheduleRefresh,
            getState: () => ({
                pricePerBB: state.pricePerBB,
                categoryCache: { ...state.categoryCache },
                bbTable: JSON.parse(JSON.stringify(state.bbTable)),
                dollarTable: JSON.parse(JSON.stringify(state.dollarTable)),
                itemCatalogSize: Object.keys(state.itemCatalog).length,
                itemCatalogLoaded: state.itemCatalogLoaded,
                itemCatalogError: state.itemCatalogError,
                hasApiKey: !!getApiKey()
            })
        };
    }

    init();
})();
