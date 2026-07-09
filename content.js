const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// Listen for messages from popup / background
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'filterResults') {
        filterState.active = true;
        filterState.sortMode = request.sortMode || 'amazon';
        startFiltering(request.searchTerm, request.caseSensitive, request.highlightMatch);
        sendResponse({status: 'Filtering started'});
    } else if (request.action === 'clearFilter') {
        clearFilter();
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
    retryTimers: []
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

// Resume filtering when user returns to a tab or reloads a results page
if (isAmazonSearchPage()) {
    chrome.runtime.sendMessage({ action: 'getTabFilterState' }, function(response) {
        if (chrome.runtime.lastError || !response || !response.shouldFilter || !response.searchTerm) {
            return;
        }

        filterState.sortMode = response.sortMode || 'amazon';
        filterState.active = true;
        startFiltering(response.searchTerm, response.caseSensitive, response.highlightMatch);
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
    return /\/\s*count|per\s+count|\/\s*unit|per\s+unit|per\s+item/i.test(priceEl.textContent);
}

function getProductPrice(product) {
    const candidates = [];

    product.querySelectorAll('.a-price').forEach(priceEl => {
        if (isPerUnitPriceBlock(priceEl)) {
            return;
        }

        const offscreen = priceEl.querySelector('.a-offscreen');
        if (offscreen) {
            const value = parsePriceText(offscreen.textContent);
            if (value !== null) {
                candidates.push(value);
            }
            return;
        }

        const whole = priceEl.querySelector('.a-price-whole');
        const fraction = priceEl.querySelector('.a-price-fraction');
        if (whole) {
            const value = parsePriceText(`${whole.textContent}${fraction ? fraction.textContent : ''}`);
            if (value !== null) {
                candidates.push(value);
            }
        }
    });

    if (candidates.length > 0) {
        const mainPrices = candidates.filter(value => value >= 1);
        if (mainPrices.length > 0) {
            return Math.min(...mainPrices);
        }
        return Math.min(...candidates);
    }

    // Fallback: use the largest price on the card (avoids $0.09/count-style values)
    let highest = null;
    product.querySelectorAll('.a-price .a-offscreen, .a-color-price .a-offscreen').forEach(el => {
        const value = parsePriceText(el.textContent);
        if (value !== null && (highest === null || value > highest)) {
            highest = value;
        }
    });

    return highest;
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

    const priceA = a.price ?? Infinity;
    const priceB = b.price ?? Infinity;

    if (sortMode === 'price') {
        return priceA - priceB;
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

    return priceA - priceB;
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
    document.querySelectorAll('[data-component-type="s-search-result"]').forEach(result => {
        result.style.order = '';
    });

    const listParent = document.querySelector('[data-exact-search-sortable="true"]');
    if (listParent) {
        listParent.style.display = '';
        listParent.style.flexDirection = '';
        listParent.removeAttribute('data-exact-search-sortable');
    }
}

function applyFlexSortOrder(sortedUnits) {
    const listParent = getResultsRowParent();
    if (!listParent) {
        return;
    }

    listParent.setAttribute('data-exact-search-sortable', 'true');
    listParent.style.display = 'flex';
    listParent.style.flexDirection = 'column';

    sortedUnits.forEach((unit, index) => {
        unit.style.order = String(index);
    });

    document.querySelectorAll('.exact-search-hidden').forEach(hidden => {
        const unit = getSortableUnit(hidden);
        unit.style.order = String(sortedUnits.length + 1);
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
        clearSortStyles();
        return;
    }

    const matches = Array.from(document.querySelectorAll('.exact-search-match'));
    if (matches.length < 2) {
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
            wrapper: getReorderWrapper(unit),
            price: getProductPrice(unit),
            deliveryDays: getDeliveryDays(unit),
            originalIndex: filterState.amazonOrder.get(unit) ?? Number.MAX_SAFE_INTEGER
        });
    });

    if (items.length < 2) {
        return;
    }

    items.sort((a, b) => compareMatchedItems(a, b, sortMode));

    const sortedUnits = items.map(item => item.unit);
    applyFlexSortOrder(sortedUnits);

    const { parent, wrappers } = normalizeWrappersForParent(items.map(item => item.wrapper));
    if (parent && wrappers.length > 1) {
        reorderProductWrappers(parent, wrappers);
    }
}

function setSortMode(sortMode) {
    filterState.sortMode = sortMode;
    chrome.storage.local.set({ sortMode });
    updateSortButtons();
    beginInternalUpdate();
    sortVisibleMatches(sortMode);
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
    summary.querySelector('.exact-search-clear-btn').addEventListener('click', clearFilter);

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

    // Inch/fraction sizes like 1/4", 3/8, #8
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
                product.classList.add('exact-search-hidden');
                product.style.display = 'none';
                hiddenItems.push(buildHiddenItem(product, titleInfo));
                hiddenCount++;
                return;
            }

            const isMatch = titleMatchesSearch(titleInfo.text, searchTerm, caseSensitive);

            if (isMatch) {
                product.classList.remove('exact-search-hidden');
                product.style.display = '';
                product.classList.add('exact-search-match');
                visibleCount++;

                if (highlightMatch && !product.dataset.exactSearchHighlighted) {
                    highlightText(titleInfo.element, searchTerm, caseSensitive);
                    product.dataset.exactSearchHighlighted = '1';
                }

                addMatchBadge(product);
            } else {
                product.classList.add('exact-search-hidden');
                product.classList.remove('exact-search-match');
                product.style.display = 'none';
                delete product.dataset.exactSearchHighlighted;
                hiddenItems.push(buildHiddenItem(product, titleInfo));
                hiddenCount++;
            }
        });

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
        const flags = caseSensitive ? 'g' : 'gi';
        let pattern;

        if (/^M\d+$/i.test(part.text)) {
            pattern = `(?<![A-Za-z0-9])${escapeRegExp(part.text)}(?![0-9A-Za-z])`;
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
    summary.querySelector('.exact-search-summary-detail').textContent =
        `Showing only titles matching: "${searchTerm}" (quoted text must appear exactly)`;
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

function clearFilter() {
    filterState.active = false;
    filterState.hiddenResults = null;
    filterState.amazonOrder = new Map();
    clearSortStyles();
    chrome.storage.local.set({ filterEnabled: false, activeFilterTabId: null });
    cleanupFilteringWatchers();
    closeHiddenResultsModal();

    document.querySelectorAll('.exact-search-hidden, .exact-search-match').forEach(el => {
        el.classList.remove('exact-search-hidden', 'exact-search-match');
        el.style.display = '';
        el.style.border = '';
        el.style.borderRadius = '';
        el.style.padding = '';
        el.style.margin = '';
        el.style.backgroundColor = '';
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
}

function mutationIsRelevant(mutations) {
    return mutations.some(mutation => {
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes];

        for (const node of nodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) {
                continue;
            }

            if (node.classList?.contains('exact-search-summary') ||
                node.classList?.contains('exact-match-badge') ||
                node.classList?.contains('exact-search-highlight') ||
                node.classList?.contains('exact-search-hidden-modal') ||
                node.closest?.('.exact-search-summary') ||
                node.closest?.('.exact-search-hidden-modal')) {
                return false;
            }
        }

        if (mutation.target.closest?.('.exact-search-summary') ||
            mutation.target.closest?.('.exact-search-hidden-modal') ||
            mutation.target.closest?.('.exact-search-highlight') ||
            mutation.target.closest?.('.exact-match-badge')) {
            return false;
        }

        return true;
    });
}

function observePageChanges(searchTerm, caseSensitive, highlightMatch) {
    if (filterState.observer) {
        filterState.observer.disconnect();
    }

    filterState.observer = new MutationObserver(function(mutations) {
        if (!filterState.active || filterState.isInternalUpdate || !mutationIsRelevant(mutations)) {
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
