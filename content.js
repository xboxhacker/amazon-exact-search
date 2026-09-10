const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// Listen for messages from popup / background
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'filterResults') {
        filterState.active = true;
        filterState.sortMode = request.sortMode || 'amazon';
        startFiltering(request.searchTerm, request.caseSensitive, request.highlightMatch);
        sendResponse({status: 'Filtering started'});
    } else if (request.action === 'clearFilter') {
        clearFilter(false);
        sendResponse({status: 'Filter cleared'});
    }
    return true;
});

const filterState = {
    active: false,
    sortMode: 'amazon',
    amazonOrder: new Map(),
    isInternalUpdate: false,
    hiddenResults: null,
    observer: null,
    debounceTimer: null,
    retryTimers: [],
    sessionAmazonKey: null,
    navWatcherStarted: false,
    lastSortPreview: ''
};

function beginInternalUpdate() {
    filterState.isInternalUpdate = true;
}

function endInternalUpdate() {
    // setTimeout instead of requestAnimationFrame: rAF never fires in
    // background tabs, which would leave the observer disabled forever.
    setTimeout(() => {
        filterState.isInternalUpdate = false;
    }, 50);
}

function isAmazonSearchPage() {
    return /amazon\.com/i.test(location.hostname) &&
        (location.pathname === '/s' || location.pathname.startsWith('/s/'));
}

function getAmazonSearchKeyFromLocation() {
    const params = new URLSearchParams(window.location.search);
    const k = params.get('k');
    if (!k) {
        return '';
    }

    return decodeURIComponent(k.replace(/\+/g, ' ')).trim().toLowerCase().replace(/\s+/g, ' ');
}

function endFilterSession(options) {
    const reload = !!(options && options.reload);

    clearFilter(false);
    chrome.runtime.sendMessage({ action: 'endFilterSession' }, function() {
        if (reload && isAmazonSearchPage()) {
            // Hard restore: Amazon re-renders the original unfiltered results page
            window.location.reload();
        }
    });
}

// Resume filtering when user returns to a tab or reloads a results page
if (isAmazonSearchPage()) {
    chrome.runtime.sendMessage({ action: 'getTabFilterState' }, function(response) {
        if (chrome.runtime.lastError || !response || !response.shouldFilter || !response.searchTerm) {
            return;
        }

        filterState.sortMode = response.sortMode || 'amazon';
        filterState.active = true;
        filterState.sessionAmazonKey = getAmazonSearchKeyFromLocation();
        startFiltering(response.searchTerm, response.caseSensitive, response.highlightMatch);
    });
} else {
    // Navigated to cart, product page, etc. — end any active filter session for this tab
    chrome.runtime.sendMessage({ action: 'getTabFilterState' }, function(response) {
        if (chrome.runtime.lastError || !response || !response.shouldFilter) {
            return;
        }

        chrome.runtime.sendMessage({ action: 'endFilterSession' }).catch(() => {});
    });
}

function cleanupFilteringWatchers() {
    if (filterState.observer) {
        filterState.observer.disconnect();
        filterState.observer = null;
    }

    if (filterState.debounceTimer) {
        clearTimeout(filterState.debounceTimer);
        filterState.debounceTimer = null;
    }

    filterState.retryTimers.forEach(id => clearTimeout(id));
    filterState.retryTimers = [];
}

function startFiltering(searchTerm, caseSensitive, highlightMatch) {
    if (!isAmazonSearchPage()) {
        return;
    }

    filterState.sessionAmazonKey = getAmazonSearchKeyFromLocation();
    cleanupFilteringWatchers();

    const run = () => {
        if (filterState.active) {
            filterAmazonResults(searchTerm, caseSensitive, highlightMatch);
        }
    };

    run();
    [500, 1000, 2000, 3500, 5000].forEach(delay => {
        filterState.retryTimers.push(setTimeout(run, delay));
    });

    observePageChanges(searchTerm, caseSensitive, highlightMatch);
    watchAmazonSearchNavigation();
}

function watchAmazonSearchNavigation() {
    if (filterState.navWatcherStarted) {
        return;
    }

    filterState.navWatcherStarted = true;

    // Catch SPA / history navigations where the Amazon query changes
    const check = () => {
        if (!filterState.active) {
            return;
        }

        if (!isAmazonSearchPage()) {
            endFilterSession();
            return;
        }

        const currentKey = getAmazonSearchKeyFromLocation();
        if (filterState.sessionAmazonKey && currentKey && currentKey !== filterState.sessionAmazonKey) {
            endFilterSession();
        }
    };

    window.addEventListener('popstate', check);
    setInterval(check, 1000);
}

function getProductElements() {
    const seen = new Set();
    const products = [];

    document.querySelectorAll('[data-component-type="s-search-result"], .s-result-item[data-asin]').forEach(el => {
        const unit = el.matches('[data-component-type="s-search-result"], .s-result-item') ?
            el : el.closest('[data-component-type="s-search-result"], .s-result-item');
        if (!unit || seen.has(unit)) {
            return;
        }

        const asin = unit.getAttribute('data-asin');
        if (!asin || asin.length < 5) {
            return;
        }

        seen.add(unit);
        products.push(unit);
    });

    if (products.length > 0) {
        return products;
    }

    document.querySelectorAll('div[data-asin]:not([data-asin=""])').forEach(el => {
        if (seen.has(el)) {
            return;
        }

        const asin = el.getAttribute('data-asin');
        if (!asin || asin.length < 5) {
            return;
        }

        seen.add(el);
        products.push(el);
    });

    return products;
}

function getProductTitle(product) {
    const titleSelectors = [
        'h2 a span.a-text-normal',
        'h2 span.a-text-normal',
        'h2 a span',
        'h2 span',
        'h2 a',
        'h2',
        '.a-size-medium.a-color-base.a-text-normal',
        '.a-size-base-plus.a-color-base.a-text-normal',
        '[data-cy="title-recipe"]',
        '.a-text-normal'
    ];

    for (const selector of titleSelectors) {
        const el = product.querySelector(selector);
        if (el && el.textContent.trim()) {
            return { element: el, text: el.textContent.trim() };
        }
    }

    return null;
}

function getProductInfo(product, titleInfo) {
    const asin = product.getAttribute('data-asin') || '';
    const title = titleInfo?.text || 'Unknown title';
    const link = product.querySelector('h2 a[href], a.a-link-normal[href*="/dp/"], a[href*="/dp/"]');
    let url = asin ? `https://www.amazon.com/dp/${asin}` : '';

    if (link && link.href) {
        url = link.href.split('?')[0].split('#')[0];
    }

    const img = product.querySelector('img.s-image, img[src*="images-amazon"]');
    const imageUrl = img && img.src ? img.src : '';

    return { asin, title, url, imageUrl };
}

function buildHiddenItem(product, titleInfo) {
    return getProductInfo(product, titleInfo);
}

function enrichHiddenItem(item, product) {
    const delivery = getDeliveryInfo(product);
    return {
        ...item,
        price: getProductPrice(product),
        deliveryDays: delivery.days,
        deliveryLabel: delivery.label || (delivery.days !== null ? `Delivery in ${delivery.days} day(s)` : '')
    };
}

function dedupeHiddenItems(items) {
    const seen = new Set();

    return items.filter(item => {
        const key = item.asin || item.url || item.title;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function saveHiddenResults(searchTerm, hiddenItems) {
    // Kept in memory only; content scripts can't write chrome.storage.session.
    filterState.hiddenResults = {
        searchTerm,
        sourceUrl: window.location.href,
        items: dedupeHiddenItems(hiddenItems),
        updatedAt: Date.now()
    };
}

function closeHiddenResultsModal() {
    const modal = document.querySelector('.exact-search-hidden-modal');
    if (modal) {
        modal.hidden = true;
    }
}

function showHiddenResultsModal() {
    const render = (results) => {
        if (!results || !results.items || results.items.length === 0) {
            return;
        }

        const items = results.items.map(item => {
            if (item.price !== undefined && item.price !== null) {
                return item;
            }

            const product = item.asin ?
                document.querySelector(`[data-asin="${item.asin}"]`) : null;
            return product ? enrichHiddenItem(item, product) : item;
        });

        let modal = document.querySelector('.exact-search-hidden-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.className = 'exact-search-hidden-modal';
            modal.innerHTML = `
                <div class="exact-search-hidden-modal-backdrop"></div>
                <div class="exact-search-hidden-modal-panel" role="dialog" aria-modal="true" aria-label="Hidden results">
                    <div class="exact-search-hidden-modal-header">
                        <h2>Hidden Results</h2>
                        <button type="button" class="exact-search-hidden-modal-close" aria-label="Close">&times;</button>
                    </div>
                    <div class="exact-search-hidden-modal-meta"></div>
                    <div class="exact-search-hidden-modal-list"></div>
                </div>
            `;
            document.body.appendChild(modal);
            modal.querySelector('.exact-search-hidden-modal-backdrop').addEventListener('click', closeHiddenResultsModal);
            modal.querySelector('.exact-search-hidden-modal-close').addEventListener('click', closeHiddenResultsModal);
        }

        modal.querySelector('.exact-search-hidden-modal-meta').innerHTML = `
            <strong>Search:</strong> "${escapeHtml(results.searchTerm)}"<br>
            <strong>${items.length}</strong> listing${items.length === 1 ? '' : 's'} hidden because the title did not match.
        `;

        const list = modal.querySelector('.exact-search-hidden-modal-list');
        list.innerHTML = items.map(item => {
            const priceLabel = item.price !== null && item.price !== undefined ?
                `$${item.price.toFixed(2)}` : 'Price unavailable';
            const deliveryLabel = item.deliveryLabel || 'Delivery unknown';
            const url = item.url || (item.asin ? `https://www.amazon.com/dp/${item.asin}` : '#');

            return `
                <a class="exact-search-hidden-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
                    ${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="">` : ''}
                    <div class="exact-search-hidden-item-body">
                        <div class="exact-search-hidden-item-title">${escapeHtml(item.title)}</div>
                        <div class="exact-search-hidden-item-meta">${escapeHtml(priceLabel)} · ${escapeHtml(deliveryLabel)}</div>
                        ${item.asin ? `<div class="exact-search-hidden-item-asin">ASIN: ${escapeHtml(item.asin)}</div>` : ''}
                    </div>
                </a>
            `;
        }).join('');

        modal.hidden = false;
    };

    render(filterState.hiddenResults);
}

function openHiddenResultsPage() {
    showHiddenResultsModal();
}

function parsePriceText(text) {
    if (!text) return null;
    const cleaned = text.replace(/[^0-9.,]/g, '').replace(/,/g, '');
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? null : num;
}

function isPerUnitPriceBlock(priceEl) {
    const text = priceEl.textContent || '';
    return /\/\s*count|per\s+count|\/\s*unit|per\s+unit|per\s+item|\/\s*month|with\s+prime/i.test(text);
}

function getProductPrice(product) {
    const preferredSelectors = [
        '.a-price[data-a-size="xl"][data-a-color="base"] .a-offscreen',
        '.a-price[data-a-size="l"][data-a-color="base"] .a-offscreen',
        '.a-price[data-a-color="base"] .a-offscreen',
        '.a-price[data-a-size="xl"] .a-offscreen'
    ];

    for (const selector of preferredSelectors) {
        const el = product.querySelector(selector);
        if (!el) {
            continue;
        }
        const priceEl = el.closest('.a-price');
        if (priceEl && isPerUnitPriceBlock(priceEl)) {
            continue;
        }
        const value = parsePriceText(el.textContent);
        if (value !== null && value >= 1) {
            return value;
        }
    }

    const candidates = [];
    product.querySelectorAll('.a-price').forEach(priceEl => {
        if (isPerUnitPriceBlock(priceEl)) {
            return;
        }
        // Skip secondary/strikethrough list prices when a base price exists
        if (priceEl.getAttribute('data-a-strike') === 'true') {
            return;
        }

        const offscreen = priceEl.querySelector('.a-offscreen');
        if (offscreen) {
            const value = parsePriceText(offscreen.textContent);
            if (value !== null && value >= 1) {
                candidates.push(value);
            }
            return;
        }

        const whole = priceEl.querySelector('.a-price-whole');
        const fraction = priceEl.querySelector('.a-price-fraction');
        if (whole) {
            const value = parsePriceText(`${whole.textContent}${fraction ? fraction.textContent : ''}`);
            if (value !== null && value >= 1) {
                candidates.push(value);
            }
        }
    });

    if (candidates.length > 0) {
        return Math.min(...candidates);
    }

    return null;
}

function getCardToSort(product) {
    return getSortableUnit(product);
}

function getResultListContainer() {
    const results = Array.from(document.querySelectorAll('[data-component-type="s-search-result"]'));
    if (results.length === 0) {
        return null;
    }

    let node = results[0];
    while (node.parentElement) {
        const parent = node.parentElement;
        const productWrappers = Array.from(parent.children).filter(child =>
            child.matches('[data-component-type="s-search-result"]') ||
            child.querySelector('[data-component-type="s-search-result"]')
        );

        if (productWrappers.length >= 2) {
            return {
                parent,
                wrapperFor(unit) {
                    let wrapper = unit;
                    while (wrapper.parentElement && wrapper.parentElement !== parent) {
                        wrapper = wrapper.parentElement;
                    }
                    return wrapper;
                },
                isProductWrapper(child) {
                    return child.matches('[data-component-type="s-search-result"]') ||
                        !!child.querySelector('[data-component-type="s-search-result"]');
                }
            };
        }

        node = parent;
    }

    return null;
}

function getSortColumnWrapper(unit) {
    const container = getResultListContainer();
    if (container) {
        return container.wrapperFor(unit);
    }
    return getReorderWrapper(unit);
}

/**
 * Sort in place using flex order on Amazon's grid column wrappers.
 * Keeps the original compact multi-column card layout.
 */
function applyInPlaceSortOrder(container, sortedItems) {
    if (!container) {
        return;
    }

    const { parent, isProductWrapper } = container;
    const matchedWrappers = new Set(sortedItems.map(item => item.wrapper));

    parent.setAttribute('data-exact-search-sortable', 'true');
    parent.style.setProperty('display', 'flex', 'important');
    parent.style.setProperty('flex-wrap', 'wrap', 'important');
    parent.style.setProperty('align-items', 'flex-start', 'important');

    sortedItems.forEach((item, index) => {
        item.wrapper.style.setProperty('order', String(index), 'important');
        item.wrapper.style.removeProperty('width');
        item.wrapper.style.removeProperty('height');
        item.unit.style.setProperty('order', String(index), 'important');
    });

    Array.from(parent.children).forEach(child => {
        if (isProductWrapper(child) && !matchedWrappers.has(child)) {
            child.style.setProperty('order', '9999', 'important');
        }
    });
}

function daysUntilDate(dateStr) {
    const target = new Date(Date.parse(dateStr));
    if (Number.isNaN(target.getTime())) {
        return null;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    target.setHours(0, 0, 0, 0);

    const diff = Math.ceil((target - today) / (1000 * 60 * 60 * 24));
    return diff >= 0 ? diff : null;
}

function parseDeliveryText(text) {
    const lower = text.toLowerCase();

    if (/\btoday\b|same[\s-]?day/i.test(lower)) {
        return 0;
    }

    if (/\bovernight\b/i.test(lower)) {
        return 1;
    }

    if (/\btomorrow\b/i.test(lower)) {
        return 1;
    }

    const rangeMatch = lower.match(/(\d+)\s*[-–]\s*(\d+)\s+days?/);
    if (rangeMatch) {
        return parseInt(rangeMatch[1], 10);
    }

    const inDays = lower.match(/(?:in\s+)?(\d+)\s+days?/);
    if (inDays) {
        return parseInt(inDays[1], 10);
    }

    const weekdayDate = text.match(
        /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?),?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i
    );
    if (weekdayDate) {
        return daysUntilDate(weekdayDate[0]);
    }

    const monthDay = text.match(
        /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i
    );
    if (monthDay) {
        return daysUntilDate(monthDay[0]);
    }

    return null;
}

function collectDeliveryTexts(product) {
    const texts = [];
    const seen = new Set();

    const addText = (text) => {
        const cleaned = text && text.replace(/\s+/g, ' ').trim();
        if (!cleaned || seen.has(cleaned)) {
            return;
        }
        seen.add(cleaned);
        texts.push(cleaned);
    };

    product.querySelectorAll('[aria-label]').forEach(el => {
        const label = el.getAttribute('aria-label');
        if (/delivery|arrives|get it|overnight/i.test(label)) {
            addText(label);
        }
    });

    const selectors = [
        '[data-cy="delivery-recipe"]',
        '.udm-primary-delivery-message',
        '.a-row.a-size-base.a-color-secondary',
        '.a-color-secondary',
        '.a-size-base.a-color-secondary',
        '.a-text-bold'
    ];

    selectors.forEach(selector => {
        product.querySelectorAll(selector).forEach(el => {
            const text = el.textContent.trim();
            if (/delivery|arrives|get it|overnight|tomorrow|today/i.test(text)) {
                addText(text);
            }
        });
    });

    if (texts.length === 0) {
        const matches = product.textContent.match(/(?:get it|delivery|arrives|overnight|tomorrow)[^.]{0,120}/gi);
        if (matches) {
            matches.forEach(addText);
        }
    }

    return texts;
}

function getDeliveryInfo(product) {
    const texts = collectDeliveryTexts(product);
    let earliestDays = null;
    let earliestLabel = '';

    texts.forEach(text => {
        const segments = text.split(/\bor\s+fastest\s+delivery\b/i);
        segments.forEach(segment => {
            const days = parseDeliveryText(segment);
            if (days !== null && (earliestDays === null || days < earliestDays)) {
                earliestDays = days;
                earliestLabel = segment.trim();
            }
        });

        const fullDays = parseDeliveryText(text);
        if (fullDays !== null && (earliestDays === null || fullDays < earliestDays)) {
            earliestDays = fullDays;
            earliestLabel = text;
        }
    });

    return {
        days: earliestDays,
        label: earliestLabel
    };
}

function getDeliveryDays(product) {
    return getDeliveryInfo(product).days;
}

function getSortableUnit(product) {
    if (product.matches('[data-component-type="s-search-result"]')) {
        return product;
    }

    const searchResult = product.closest('[data-component-type="s-search-result"]');
    if (searchResult) {
        return searchResult;
    }

    const resultItem = product.closest('.s-result-item[data-asin]');
    if (resultItem) {
        return resultItem;
    }

    return product.closest('[data-asin]') || product;
}

function captureAmazonOrder() {
    let nextIndex = filterState.amazonOrder.size;

    getProductElements().forEach(product => {
        const unit = getSortableUnit(product);
        if (!filterState.amazonOrder.has(unit)) {
            filterState.amazonOrder.set(unit, nextIndex);
            nextIndex++;
        }
    });
}

function compareMatchedItems(a, b, sortMode) {
    if (sortMode === 'amazon') {
        return a.originalIndex - b.originalIndex;
    }

    const priceA = typeof a.price === 'number' ? a.price : Number.POSITIVE_INFINITY;
    const priceB = typeof b.price === 'number' ? b.price : Number.POSITIVE_INFINITY;

    if (sortMode === 'price') {
        if (priceA !== priceB) {
            return priceA - priceB;
        }
        return a.originalIndex - b.originalIndex;
    }

    const hasDeliveryA = a.deliveryDays !== null && a.deliveryDays !== undefined;
    const hasDeliveryB = b.deliveryDays !== null && b.deliveryDays !== undefined;

    if (hasDeliveryA && !hasDeliveryB) {
        return -1;
    }

    if (!hasDeliveryA && hasDeliveryB) {
        return 1;
    }

    if (hasDeliveryA && hasDeliveryB && a.deliveryDays !== b.deliveryDays) {
        return a.deliveryDays - b.deliveryDays;
    }

    if (priceA !== priceB) {
        return priceA - priceB;
    }

    return a.originalIndex - b.originalIndex;
}

function getResultsRowParent() {
    const results = Array.from(document.querySelectorAll('[data-component-type="s-search-result"]'));
    if (results.length === 0) {
        return null;
    }

    let parent = results[0].parentElement;
    while (parent) {
        const directResults = Array.from(parent.children).filter(child =>
            child.matches('[data-component-type="s-search-result"]')
        );
        if (directResults.length >= 2) {
            return parent;
        }
        parent = parent.parentElement;
    }

    return results[0].parentElement;
}

function normalizeWrappersForParent(wrappers) {
    if (wrappers.length === 0) {
        return { parent: null, wrappers: [] };
    }

    const sameParent = wrappers.every(wrapper => wrapper.parentElement === wrappers[0].parentElement);
    if (sameParent) {
        return { parent: wrappers[0].parentElement, wrappers };
    }

    const listParent = getResultsRowParent();
    if (!listParent) {
        return { parent: wrappers[0].parentElement, wrappers };
    }

    const normalized = wrappers.map(wrapper => {
        let node = wrapper;
        while (node.parentElement && node.parentElement !== listParent) {
            node = node.parentElement;
        }
        return node;
    });

    return { parent: listParent, wrappers: normalized };
}

function clearSortStyles() {
    document.querySelectorAll('[data-exact-search-sortable="true"]').forEach(parent => {
        parent.style.removeProperty('display');
        parent.style.removeProperty('flex-wrap');
        parent.style.removeProperty('flex-direction');
        parent.style.removeProperty('align-items');
        parent.removeAttribute('data-exact-search-sortable');

        Array.from(parent.children).forEach(child => {
            child.style.removeProperty('order');
            child.style.removeProperty('width');
            child.style.removeProperty('height');
        });
    });

    document.querySelectorAll('[data-component-type="s-search-result"]').forEach(result => {
        result.style.removeProperty('order');
        result.style.removeProperty('width');
        result.style.removeProperty('height');
    });
}

function getReorderWrapper(unit) {
    let node = unit;

    while (node.parentElement) {
        const parent = node.parentElement;
        const productSiblings = Array.from(parent.children).filter(child =>
            child.matches('[data-component-type="s-search-result"]') ||
            child.querySelector('[data-component-type="s-search-result"]')
        );

        if (productSiblings.length > 1) {
            return node;
        }

        node = parent;
    }

    return unit;
}

function isProductWrapper(element) {
    return element.matches('[data-component-type="s-search-result"]') ||
        !!element.querySelector('[data-component-type="s-search-result"]');
}

function reorderProductWrappers(parent, sortedWrappers) {
    const visibleSet = new Set(sortedWrappers);
    const hiddenWrappers = Array.from(parent.children).filter(child =>
        !visibleSet.has(child) && isProductWrapper(child)
    );

    sortedWrappers.forEach(wrapper => parent.appendChild(wrapper));
    hiddenWrappers.forEach(wrapper => parent.appendChild(wrapper));
}

function sortVisibleMatches(sortMode) {
    if (sortMode === 'amazon') {
        beginInternalUpdate();
        clearSortStyles();
        endInternalUpdate();
        return;
    }

    const matches = Array.from(document.querySelectorAll('.exact-search-match'));
    if (matches.length < 2) {
        clearSortStyles();
        return;
    }

    const container = getResultListContainer();
    if (!container) {
        return;
    }

    const seen = new Set();
    const items = [];

    matches.forEach(product => {
        const unit = getSortableUnit(product);
        if (seen.has(unit)) {
            return;
        }
        seen.add(unit);

        items.push({
            unit,
            wrapper: getSortColumnWrapper(unit),
            price: getProductPrice(unit),
            deliveryDays: getDeliveryDays(unit),
            originalIndex: filterState.amazonOrder.get(unit) ?? Number.MAX_SAFE_INTEGER
        });
    });

    if (items.length < 2) {
        return;
    }

    items.sort((a, b) => compareMatchedItems(a, b, sortMode));

    filterState.lastSortPreview = items
        .slice(0, 5)
        .map(item => (item.price == null ? '?' : `$${item.price.toFixed(2)}`))
        .join(' → ');

    beginInternalUpdate();
    try {
        applyInPlaceSortOrder(container, items);
    } catch (error) {
        console.error('Exact Search: sort failed', error);
    }
    endInternalUpdate();
}

function setSortMode(sortMode) {
    filterState.sortMode = sortMode;
    chrome.storage.local.set({ sortMode });
    updateSortButtons();
    beginInternalUpdate();
    sortVisibleMatches(sortMode);

    const detail = document.querySelector('.exact-search-summary-detail');
    if (detail) {
        const base = detail.textContent.split(' · Price order:')[0];
        if (sortMode !== 'amazon' && filterState.lastSortPreview) {
            detail.textContent = `${base} · Price order: ${filterState.lastSortPreview}`;
        } else {
            detail.textContent = base;
        }
    }

    endInternalUpdate();
}

function updateSortButtons() {
    document.querySelectorAll('.exact-search-sort-btn').forEach(button => {
        const isActive = button.dataset.sort === filterState.sortMode;
        button.classList.toggle('exact-search-sort-btn-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function wireSummaryEvents(summary) {
    summary.querySelector('.exact-search-clear-btn').addEventListener('click', function() {
        endFilterSession({ reload: false });
    });
    summary.querySelector('.exact-search-close-btn').addEventListener('click', function() {
        // End session and reload so Amazon shows the original unfiltered results
        endFilterSession({ reload: true });
    });

    summary.querySelectorAll('.exact-search-sort-btn').forEach(button => {
        button.addEventListener('click', function() {
            setSortMode(button.dataset.sort);
        });
    });

    const hiddenLink = summary.querySelector('.exact-search-hidden-link');
    if (hiddenLink) {
        hiddenLink.addEventListener('click', openHiddenResultsPage);
    }
}

function ensureResultsSummary() {
    let summary = document.querySelector('.exact-search-summary');

    if (summary) {
        return summary;
    }

    summary = document.createElement('div');
    summary.className = 'exact-search-summary';
    summary.innerHTML = `
        <button type="button" class="exact-search-close-btn" title="End filter and restore original Amazon results" aria-label="End filter and restore original Amazon results">&times;</button>
        <div class="exact-search-summary-row">
            <div>
                <strong>Exact Search Filter Active</strong><br>
                <span class="exact-search-summary-detail"></span>
            </div>
            <div class="exact-search-summary-counts">
                <span class="exact-search-match-count"></span> |
                <span class="exact-search-hidden-count-wrap"></span><br>
                <span class="exact-search-version">v${EXTENSION_VERSION}</span>
            </div>
        </div>
        <div class="exact-search-summary-controls">
            <div class="exact-search-sort-group">
                <span class="exact-search-sort-label">Sort matches:</span>
                <button type="button" class="exact-search-sort-btn" data-sort="amazon">Normal (no sort)</button>
                <button type="button" class="exact-search-sort-btn" data-sort="price">Lowest price</button>
                <button type="button" class="exact-search-sort-btn" data-sort="delivery-price">Fastest ship · cheapest</button>
            </div>
            <button type="button" class="exact-search-clear-btn">Show All Results (Remove Filter)</button>
        </div>
    `;

    wireSummaryEvents(summary);

    const resultsContainer = document.querySelector('[data-component-type="s-search-results"]') ||
        document.querySelector('.s-main-slot.s-result-list') ||
        document.querySelector('.s-main-slot');

    if (resultsContainer) {
        resultsContainer.insertBefore(summary, resultsContainer.firstChild);
    } else {
        document.body.insertBefore(summary, document.body.firstChild);
    }

    return summary;
}

/**
 * Parse search into required and excluded terms.
 * "4mm OD" = phrase required together
 * -4mm or -M4 = omit titles containing that term
 * -"4mm OD" = omit titles containing that exact phrase
 */
function parseSearchQuery(searchTerm) {
    const parts = [];
    const regex = /-"([^"]+)"|-(\S+)|"([^"]+)"|(\S+)/g;
    let match;

    while ((match = regex.exec(searchTerm)) !== null) {
        if (match[1] !== undefined) {
            const phrase = match[1].trim();
            if (phrase) {
                parts.push({ type: 'phrase', text: phrase, exclude: true });
            }
        } else if (match[2] !== undefined) {
            const word = match[2].trim();
            if (word) {
                parts.push({ type: 'word', text: word, exclude: true });
            }
        } else if (match[3] !== undefined) {
            const phrase = match[3].trim();
            if (phrase) {
                parts.push({ type: 'phrase', text: phrase, exclude: false });
            }
        } else if (match[4] !== undefined) {
            const word = match[4].trim();
            if (word) {
                parts.push({ type: 'word', text: word, exclude: false });
            }
        }
    }

    return parts;
}

function partAppearsInTitle(title, part, caseSensitive) {
    if (part.type === 'phrase') {
        return phraseAppearsInTitle(title, part.text, caseSensitive);
    }
    return termAppearsInTitle(title, part.text, caseSensitive);
}

function titleMatchesSearch(title, searchTerm, caseSensitive) {
    const parts = parseSearchQuery(searchTerm);
    if (parts.length === 0) {
        return false;
    }

    const required = parts.filter(part => !part.exclude);
    const excluded = parts.filter(part => part.exclude);

    if (excluded.some(part => partAppearsInTitle(title, part, caseSensitive))) {
        return false;
    }

    if (required.length === 0) {
        return true;
    }

    return required.every(part => partAppearsInTitle(title, part, caseSensitive));
}

function phraseAppearsInTitle(title, phrase, caseSensitive) {
    if (caseSensitive) {
        return title.includes(phrase);
    }

    return title.toLowerCase().includes(phrase.toLowerCase());
}

function parseMeasurementNumber(term) {
    const match = term.match(/^(\d+(?:\.\d+)?)\s*(?:"|''|inch|inches|in|-?inch)?$/i);
    if (!match) {
        return null;
    }
    return match[1];
}

function buildMeasurementRegex(num, flags) {
    const n = escapeRegExp(num);
    const patterns = [
        `(?<![0-9])${n}\\s*"`,
        `(?<![0-9])${n}\\s*'`,
        `(?<![0-9])${n}\\s*-?\\s*(?:inch|inches|in)\\b`,
        `(?<![0-9])${n}(?![0-9])`
    ];
    return new RegExp(`(?:${patterns.join('|')})`, flags);
}

function termAppearsInTitle(title, term, caseSensitive) {
    const flags = caseSensitive ? '' : 'i';

    // Metric fastener sizes: M3, M6, M10 — must not match M60, M4, etc.
    if (/^M\d+$/i.test(term)) {
        const regex = new RegExp(
            `(?<![A-Za-z0-9])${escapeRegExp(term)}(?![0-9A-Za-z])`,
            flags
        );
        return regex.test(title);
    }

    // Inch measurements: 6, 6", 6 inch, 1/4", 3/8 — match equivalent forms in title
    const measureNum = parseMeasurementNumber(term);
    if (measureNum) {
        return buildMeasurementRegex(measureNum, flags).test(title);
    }

    if (/^#?\d+([./]\d+)?"?$/.test(term)) {
        const regex = new RegExp(
            `(?<![0-9A-Za-z./#])${escapeRegExp(term.replace(/"/g, '"?'))}(?![0-9A-Za-z])`,
            flags
        );
        return regex.test(title);
    }

    // Alphanumeric part numbers (e.g. 304SS, 18-8)
    if (/[0-9]/.test(term) && /[A-Za-z]/.test(term)) {
        const regex = new RegExp(
            `(?<![A-Za-z0-9-])${escapeRegExp(term)}(?![A-Za-z0-9])`,
            flags
        );
        return regex.test(title);
    }

    // Regular words — whole word only; allow simple plurals (screw ↔ screws)
    const regex = new RegExp(`\\b${escapeRegExp(term)}(?:s|es)?\\b`, flags);
    return regex.test(title);
}

function setElementVisible(el, visible) {
    if (!el) {
        return;
    }

    if (visible) {
        el.classList.remove('exact-search-hidden');
        el.style.display = '';
    } else {
        el.classList.add('exact-search-hidden');
        el.style.display = 'none';
    }
}

function setProductVisibility(product, visible) {
    const unit = getSortableUnit(product);

    // Only hide the product card itself. Hiding Amazon's parent wrappers
    // also hides sibling matches that share the same batch container.
    setElementVisible(product, visible);
    if (unit !== product) {
        setElementVisible(unit, visible);
    }
}

function revealHiddenMatchAncestors() {
    document.querySelectorAll('.exact-search-match').forEach(match => {
        setElementVisible(match, true);
        let node = match.parentElement;
        while (node && node !== document.body) {
            if (node.classList.contains('exact-search-hidden') || node.style.display === 'none') {
                setElementVisible(node, true);
            }
            node = node.parentElement;
        }
    });
}

function getResultsSlot() {
    return document.querySelector('.s-main-slot') ||
        document.querySelector('[data-component-type="s-search-results"]');
}

function normalizeUiText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function isLazyLoadLabel(text) {
    const value = normalizeUiText(text);
    return /^(more results|see more results|show more results)$/i.test(value);
}

function slotChildHasProductCard(child) {
    return child.matches('[data-component-type="s-search-result"]') ||
        !!child.querySelector('[data-component-type="s-search-result"]');
}

function getSlotDirectChild(node, slot) {
    let current = node;
    while (current && current.parentElement && current.parentElement !== slot) {
        current = current.parentElement;
    }
    return current && current.parentElement === slot ? current : null;
}

function hideIfPlaceholderHost(el, slot) {
    if (!el || el.classList.contains('exact-search-summary') ||
        el.classList.contains('exact-search-results-floor') ||
        el.classList.contains('exact-search-match') ||
        el.querySelector('.exact-search-match')) {
        return;
    }

    if (slotChildHasProductCard(el)) {
        return;
    }

    el.classList.add('exact-search-lazy-suppressed');
}

/**
 * Amazon infinite-scrolls when filtered cards collapse the page and its
 * "More results" sentinels stay in the viewport. Hide those loaders while
 * the filter is active so it cannot keep fetching forever.
 */
function suppressAmazonLazyLoad() {
    document.documentElement.classList.add('exact-search-filtering');
    document.body.classList.add('exact-search-filtering');

    const slot = getResultsSlot();
    if (!slot) {
        return;
    }

    slot.classList.add('exact-search-filtering-slot');

    slot.querySelectorAll('.s-result-list-placeholder, .s-latency-msg, [data-component-type="s-result-list-placeholder"]').forEach(el => {
        hideIfPlaceholderHost(getSlotDirectChild(el, slot) || el, slot);
    });

    Array.from(slot.children).forEach(child => {
        const text = normalizeUiText(child.textContent);
        const looksLikeLoader = child.classList.contains('s-result-list-placeholder') ||
            child.getAttribute('data-component-type') === 's-result-list-placeholder' ||
            child.querySelector('.s-result-list-placeholder') ||
            isLazyLoadLabel(text) ||
            (/more results/i.test(text) && text.length < 80);

        if (looksLikeLoader) {
            hideIfPlaceholderHost(child, slot);
        }
    });

    slot.querySelectorAll('h1, h2, h3, h4, span, div, p, a, button').forEach(el => {
        if (el.closest('.exact-search-summary, .exact-search-match, .exact-search-hidden-modal')) {
            return;
        }

        if (!isLazyLoadLabel(el.textContent)) {
            return;
        }

        const child = getSlotDirectChild(el, slot);
        hideIfPlaceholderHost(child || el, slot);
        if (child && slotChildHasProductCard(child)) {
            el.classList.add('exact-search-lazy-suppressed');
        }
    });
}

/**
 * Keep the results area tall enough that Amazon's scroll sentinel stays
 * below the fold even after most listings are hidden.
 */
function ensureResultsFloor() {
    const slot = getResultsSlot();
    if (!slot) {
        return;
    }

    let floor = slot.querySelector(':scope > .exact-search-results-floor');
    if (!floor) {
        floor = document.createElement('div');
        floor.className = 'exact-search-results-floor';
        floor.setAttribute('aria-hidden', 'true');
        slot.appendChild(floor);
    }

    const viewportNeed = Math.max(window.innerHeight, 900);
    const slotTop = slot.getBoundingClientRect().top + window.scrollY;
    const contentBottom = Array.from(slot.children).reduce((max, child) => {
        if (child.classList.contains('exact-search-results-floor') ||
            child.classList.contains('exact-search-lazy-suppressed') ||
            child.classList.contains('exact-search-hidden')) {
            return max;
        }
        return Math.max(max, child.getBoundingClientRect().bottom + window.scrollY);
    }, slotTop);

    const visibleContentHeight = Math.max(0, contentBottom - slotTop);
    const floorHeight = Math.max(viewportNeed - visibleContentHeight + 200, 400);
    floor.style.height = `${floorHeight}px`;
}

function clearLazyLoadSuppression() {
    document.documentElement.classList.remove('exact-search-filtering');
    document.body.classList.remove('exact-search-filtering');
    document.querySelectorAll('.exact-search-filtering-slot').forEach(el => {
        el.classList.remove('exact-search-filtering-slot');
    });
    document.querySelectorAll('.exact-search-lazy-suppressed').forEach(el => {
        el.classList.remove('exact-search-lazy-suppressed');
    });
    document.querySelectorAll('.exact-search-results-floor').forEach(el => el.remove());
}

function filterAmazonResults(searchTerm, caseSensitive, highlightMatch) {
    if (!filterState.active) {
        return;
    }

    beginInternalUpdate();

    try {
        console.log(`Filtering for exact title match: "${searchTerm}"`);

        captureAmazonOrder();

        const products = getProductElements();
        console.log(`Found ${products.length} product listings`);

        let visibleCount = 0;
        let hiddenCount = 0;
        const hiddenItems = [];

        products.forEach(product => {
            const titleInfo = getProductTitle(product);

            if (!titleInfo) {
                setProductVisibility(product, false);
                hiddenItems.push(buildHiddenItem(product, titleInfo));
                hiddenCount++;
                return;
            }

            const isMatch = titleMatchesSearch(titleInfo.text, searchTerm, caseSensitive);

            if (isMatch) {
                setProductVisibility(product, true);
                product.classList.add('exact-search-match');
                visibleCount++;

                if (highlightMatch && !product.dataset.exactSearchHighlighted) {
                    highlightText(titleInfo.element, searchTerm, caseSensitive);
                    product.dataset.exactSearchHighlighted = '1';
                }

                addMatchBadge(product);
            } else {
                setProductVisibility(product, false);
                product.classList.remove('exact-search-match');
                delete product.dataset.exactSearchHighlighted;
                hiddenItems.push(buildHiddenItem(product, titleInfo));
                hiddenCount++;
            }
        });

        revealHiddenMatchAncestors();
        visibleCount = document.querySelectorAll('.exact-search-match').length;
        suppressAmazonLazyLoad();
        ensureResultsFloor();
        saveHiddenResults(searchTerm, hiddenItems);
        sortVisibleMatches(filterState.sortMode);
        showResultsSummary(visibleCount, hiddenCount, searchTerm);
        endInternalUpdate();

        console.log(`Filtering complete: ${visibleCount} shown, ${hiddenCount} hidden`);
    } catch (error) {
        console.error('Exact Search filter failed:', error);
        endInternalUpdate();
    }
}

function highlightText(element, searchTerm, caseSensitive) {
    const parts = parseSearchQuery(searchTerm).filter(part => !part.exclude);
    const phrases = parts.filter(part => part.type === 'phrase').sort((a, b) => b.text.length - a.text.length);
    const words = parts.filter(part => part.type === 'word');

    phrases.forEach(part => {
        highlightPattern(element, escapeRegExp(part.text), caseSensitive, false);
    });

    words.forEach(part => {
        let pattern;

        if (/^M\d+$/i.test(part.text)) {
            pattern = `(?<![A-Za-z0-9])${escapeRegExp(part.text)}(?![0-9A-Za-z])`;
        } else if (parseMeasurementNumber(part.text)) {
            const num = parseMeasurementNumber(part.text);
            const n = escapeRegExp(num);
            pattern = `(?<![0-9])${n}\\s*"|(?<![0-9])${n}\\s*'|(?<![0-9])${n}\\s*-?\\s*(?:inch|inches|in)\\b|(?<![0-9])${n}(?![0-9])`;
        } else {
            pattern = `\\b${escapeRegExp(part.text)}(?:s|es)?\\b`;
        }

        highlightPattern(element, pattern, caseSensitive, true);
    });
}

function highlightPattern(element, pattern, caseSensitive, isRegex) {
    const flags = isRegex ? (caseSensitive ? 'g' : 'gi') : (caseSensitive ? 'g' : 'gi');
    const regex = isRegex ?
        new RegExp(`(${pattern})`, flags) :
        new RegExp(`(${pattern})`, flags);

    const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                const tag = node.parentElement && node.parentElement.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const textNodes = [];
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    textNodes.forEach(textNode => {
        const text = textNode.textContent;
        if (!regex.test(text)) return;

        regex.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                fragment.appendChild(
                    document.createTextNode(text.substring(lastIndex, match.index))
                );
            }

            const mark = document.createElement('mark');
            mark.textContent = match[1] || match[0];
            mark.className = 'exact-search-highlight';
            fragment.appendChild(mark);

            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < text.length) {
            fragment.appendChild(
                document.createTextNode(text.substring(lastIndex))
            );
        }

        textNode.parentNode.replaceChild(fragment, textNode);
    });
}

function addMatchBadge(product) {
    const existingBadge = product.querySelector('.exact-match-badge');
    if (existingBadge) return;

    const badge = document.createElement('div');
    badge.className = 'exact-match-badge';
    badge.textContent = 'EXACT TITLE MATCH';
    product.insertBefore(badge, product.firstChild);
}

function showResultsSummary(visibleCount, hiddenCount, searchTerm) {
    const summary = ensureResultsSummary();
    let detail = `Showing only titles matching: "${searchTerm}" (quoted text must appear exactly)`;
    if (filterState.sortMode !== 'amazon' && filterState.lastSortPreview) {
        detail += ` · Price order: ${filterState.lastSortPreview}`;
    }
    summary.querySelector('.exact-search-summary-detail').textContent = detail;
    summary.querySelector('.exact-search-match-count').textContent = `${visibleCount} matches`;

    const hiddenWrap = summary.querySelector('.exact-search-hidden-count-wrap');
    if (hiddenCount > 0) {
        hiddenWrap.innerHTML = `<button type="button" class="exact-search-hidden-link">${hiddenCount} hidden</button>`;
        hiddenWrap.querySelector('.exact-search-hidden-link').addEventListener('click', openHiddenResultsPage);
    } else {
        hiddenWrap.innerHTML = '<span class="exact-search-hidden-count">0 hidden</span>';
    }

    updateSortButtons();

    let versionEl = summary.querySelector('.exact-search-version');
    if (!versionEl) {
        versionEl = document.createElement('span');
        versionEl.className = 'exact-search-version';
        summary.querySelector('.exact-search-summary-counts').appendChild(versionEl);
    }
    versionEl.textContent = `v${EXTENSION_VERSION}`;
}

function restoreOriginalAmazonResults() {
    beginInternalUpdate();

    clearSortStyles();
    clearLazyLoadSuppression();

    document.querySelectorAll('.exact-search-hidden, .exact-search-match').forEach(el => {
        el.classList.remove('exact-search-hidden', 'exact-search-match');
        el.style.display = '';
        el.style.border = '';
        el.style.borderRadius = '';
        el.style.padding = '';
        el.style.margin = '';
        el.style.backgroundColor = '';
        el.style.removeProperty('order');
        el.style.removeProperty('width');
        el.style.removeProperty('height');
        delete el.dataset.exactSearchHighlighted;
    });

    document.querySelectorAll('.exact-match-badge').forEach(b => b.remove());
    document.querySelectorAll('.exact-search-summary').forEach(s => s.remove());
    document.querySelectorAll('.exact-search-highlight').forEach(mark => {
        const parent = mark.parentNode;
        if (parent) {
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize();
        }
    });

    closeHiddenResultsModal();
    endInternalUpdate();
}

function clearFilter(notifyBackground) {
    filterState.active = false;
    cleanupFilteringWatchers();

    restoreOriginalAmazonResults();

    filterState.hiddenResults = null;
    filterState.amazonOrder = new Map();
    filterState.sessionAmazonKey = null;

    if (notifyBackground !== false) {
        chrome.runtime.sendMessage({ action: 'endFilterSession' }).catch(() => {});
    } else {
        chrome.storage.local.set({
            filterEnabled: false,
            activeFilterTabId: null,
            activeFilterAmazonKey: null
        });
    }
}

function isOurUiNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }

    return !!(
        node.classList?.contains('exact-search-summary') ||
        node.classList?.contains('exact-match-badge') ||
        node.classList?.contains('exact-search-highlight') ||
        node.classList?.contains('exact-search-hidden-modal') ||
        node.classList?.contains('exact-search-results-floor') ||
        node.classList?.contains('exact-search-lazy-suppressed') ||
        node.closest?.('.exact-search-summary') ||
        node.closest?.('.exact-search-hidden-modal') ||
        node.closest?.('.exact-search-results-floor')
    );
}

function nodeContainsProduct(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }

    return node.matches?.('[data-component-type="s-search-result"], .s-result-item[data-asin]') ||
        !!node.querySelector?.('[data-component-type="s-search-result"], .s-result-item[data-asin]');
}

function mutationHasNewProducts(mutations) {
    return mutations.some(mutation => {
        if (isOurUiNode(mutation.target)) {
            return false;
        }

        for (const node of mutation.addedNodes) {
            if (isOurUiNode(node)) {
                continue;
            }
            if (nodeContainsProduct(node)) {
                return true;
            }
        }

        return false;
    });
}

function observePageChanges(searchTerm, caseSensitive, highlightMatch) {
    if (filterState.observer) {
        filterState.observer.disconnect();
    }

    filterState.observer = new MutationObserver(function(mutations) {
        if (!filterState.active || filterState.isInternalUpdate) {
            return;
        }

        // Always re-suppress loaders if Amazon injects more of them
        const maybeLoaders = mutations.some(mutation =>
            [...mutation.addedNodes].some(node => {
                if (!node || node.nodeType !== Node.ELEMENT_NODE || isOurUiNode(node)) {
                    return false;
                }
                const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
                return node.classList?.contains('s-result-list-placeholder') ||
                    /^more results$/i.test(text) ||
                    text.includes('More results');
            })
        );

        if (maybeLoaders) {
            beginInternalUpdate();
            suppressAmazonLazyLoad();
            ensureResultsFloor();
            endInternalUpdate();
        }

        // Only re-filter when real product cards appear (not placeholder spam)
        if (!mutationHasNewProducts(mutations)) {
            return;
        }

        clearTimeout(filterState.debounceTimer);
        filterState.debounceTimer = setTimeout(() => {
            if (filterState.active && !filterState.isInternalUpdate) {
                filterAmazonResults(searchTerm, caseSensitive, highlightMatch);
            }
        }, 800);
    });

    const target = document.querySelector('[data-component-type="s-search-results"]') ||
                  document.querySelector('.s-main-slot') ||
                  document.body;

    filterState.observer.observe(target, { childList: true, subtree: true });
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(string) {
    return string
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
